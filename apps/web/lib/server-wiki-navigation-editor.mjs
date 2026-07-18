export function moveServerWikiNode(nodes, nodeId, direction) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return nodes;
  const siblings = nodes.filter((item) => item.parentId === node.parentId);
  const index = siblings.findIndex((item) => item.id === nodeId);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return nodes;
  [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
  return flattenServerWikiNodes(nodes, new Map([[node.parentId, siblings.map((item) => item.id)]]));
}

export function indentServerWikiNode(nodes, nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return nodes;
  const siblings = nodes.filter((item) => item.parentId === node.parentId);
  const index = siblings.findIndex((item) => item.id === nodeId);
  const previous = index > 0 ? siblings[index - 1] : null;
  if (!previous || isDescendant(nodes, previous.id, node.id)) return nodes;
  return flattenServerWikiNodes(nodes.map((item) => item.id === nodeId ? { ...item, parentId: previous.id } : item));
}

export function outdentServerWikiNode(nodes, nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node?.parentId) return nodes;
  const parent = nodes.find((item) => item.id === node.parentId);
  if (!parent) return nodes;
  return flattenServerWikiNodes(nodes.map((item) => item.id === nodeId ? { ...item, parentId: parent.parentId } : item));
}

export function addServerWikiGroup(nodes, id, title) {
  if (nodes.some((item) => item.id === id)) return nodes;
  return flattenServerWikiNodes([...nodes, { id, kind: 'group', title: title.trim(), parentId: null }]);
}

export function renameServerWikiGroup(nodes, nodeId, title) {
  const normalized = title.trim().slice(0, 80);
  if (!normalized) return nodes;
  return nodes.map((item) => item.id === nodeId && item.kind === 'group' ? { ...item, title: normalized } : item);
}

export function removeServerWikiGroup(nodes, nodeId) {
  const group = nodes.find((item) => item.id === nodeId && item.kind === 'group');
  if (!group) return nodes;
  return flattenServerWikiNodes(nodes
    .filter((item) => item.id !== nodeId)
    .map((item) => item.parentId === nodeId ? { ...item, parentId: group.parentId } : item));
}

export function serverWikiNodeControls(nodes, nodeId, rootId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node || nodeId === rootId) return { up: false, down: false, indent: false, outdent: false };
  const siblings = nodes.filter((item) => item.parentId === node.parentId);
  const index = siblings.findIndex((item) => item.id === nodeId);
  return {
    up: index > 0,
    down: index >= 0 && index < siblings.length - 1,
    indent: index > 0,
    outdent: node.parentId !== null,
  };
}

export function serverWikiNodeDepth(nodes, nodeId) {
  let node = nodes.find((item) => item.id === nodeId);
  const visited = new Set([nodeId]);
  let depth = 0;
  while (node?.parentId && !visited.has(node.parentId)) {
    visited.add(node.parentId);
    depth += 1;
    node = nodes.find((item) => item.id === node.parentId);
  }
  return depth;
}

export function emptyServerWikiGroupIds(nodes) {
  const pageAncestors = new Set();
  for (const page of nodes.filter((node) => node.kind === 'page')) {
    let parentId = page.parentId;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      pageAncestors.add(parentId);
      parentId = nodes.find((node) => node.id === parentId)?.parentId ?? null;
    }
  }
  return nodes.filter((node) => node.kind === 'group' && !pageAncestors.has(node.id)).map((node) => node.id);
}

export function flattenServerWikiNodes(nodes, siblingOrders = new Map()) {
  const children = new Map();
  for (const node of nodes) {
    const group = children.get(node.parentId) ?? [];
    group.push(node);
    children.set(node.parentId, group);
  }
  for (const [parentId, order] of siblingOrders) {
    const rank = new Map(order.map((id, index) => [id, index]));
    children.get(parentId)?.sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const flattened = [];
  const visited = new Set();
  const visit = (node) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    flattened.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const node of children.get(null) ?? []) visit(node);
  for (const node of nodes) visit(node);
  return flattened;
}

function isDescendant(nodes, candidateId, ancestorId) {
  let current = nodes.find((item) => item.id === candidateId);
  const visited = new Set();
  while (current?.parentId && !visited.has(current.parentId)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.parentId);
    current = nodes.find((item) => item.id === current.parentId);
  }
  return false;
}
