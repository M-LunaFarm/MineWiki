'use client';

import { useEffect } from 'react';

interface WikiReaderInteractionHydratorProps {
  readonly targetId: string;
  readonly revisionId: string;
}

const MOBILE_QUERY = '(max-width: 767px)';

export function WikiReaderInteractionHydrator({ targetId, revisionId }: WikiReaderInteractionHydratorProps) {
  useEffect(() => {
    const root = document.getElementById(targetId);
    if (!root) return;
    const cleanupHeadings = hydrateHeadingSections(root, revisionId);
    const cleanupDeferredFiles = hydrateDeferredFiles(root);
    const references = Array.from(root.querySelectorAll<HTMLAnchorElement>('.wiki-footnote-ref > a[href^="#fn-"]'));
    if (references.length === 0) return () => {
      cleanupHeadings();
      cleanupDeferredFiles();
    };

    const popover = document.createElement('aside');
    popover.className = 'wiki-footnote-popover';
    popover.setAttribute('role', 'note');
    popover.setAttribute('aria-label', '각주 미리보기');
    popover.hidden = true;
    const usesLightSurface = root.closest('.server-wiki-layout') !== null;
    if (usesLightSurface) popover.classList.add('wiki-footnote-light');
    document.body.append(popover);

    const dialog = buildFootnoteDialog();
    if (usesLightSurface) dialog.element.classList.add('wiki-footnote-light');
    document.body.append(dialog.element);
    let activeReference: HTMLAnchorElement | null = null;
    let hideTimer: number | null = null;

    const clearHideTimer = () => {
      if (hideTimer === null) return;
      window.clearTimeout(hideTimer);
      hideTimer = null;
    };
    const hidePopover = () => {
      clearHideTimer();
      popover.hidden = true;
      popover.replaceChildren();
    };
    const scheduleHide = () => {
      clearHideTimer();
      hideTimer = window.setTimeout(hidePopover, 100);
    };
    const showPopover = (reference: HTMLAnchorElement) => {
      if (window.matchMedia(MOBILE_QUERY).matches) return;
      const note = resolveFootnote(root, reference);
      if (!note) return;
      clearHideTimer();
      popover.replaceChildren(cloneFootnoteContent(note));
      popover.hidden = false;
      positionPopover(popover, reference);
    };
    const openDialog = (reference: HTMLAnchorElement): boolean => {
      const note = resolveFootnote(root, reference);
      if (!note || typeof dialog.element.showModal !== 'function') return false;
      activeReference = reference;
      dialog.content.replaceChildren(cloneFootnoteContent(note));
      dialog.element.showModal();
      dialog.close.focus();
      return true;
    };

    const cleanups = references.map((reference) => {
      const onMouseEnter = () => showPopover(reference);
      const onMouseLeave = () => scheduleHide();
      const onFocus = () => showPopover(reference);
      const onBlur = () => scheduleHide();
      const onClick = (event: MouseEvent) => {
        if (!window.matchMedia(MOBILE_QUERY).matches) return;
        if (openDialog(reference)) event.preventDefault();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        hidePopover();
        reference.focus();
      };
      reference.addEventListener('mouseenter', onMouseEnter);
      reference.addEventListener('mouseleave', onMouseLeave);
      reference.addEventListener('focus', onFocus);
      reference.addEventListener('blur', onBlur);
      reference.addEventListener('click', onClick);
      reference.addEventListener('keydown', onKeyDown);
      return () => {
        reference.removeEventListener('mouseenter', onMouseEnter);
        reference.removeEventListener('mouseleave', onMouseLeave);
        reference.removeEventListener('focus', onFocus);
        reference.removeEventListener('blur', onBlur);
        reference.removeEventListener('click', onClick);
        reference.removeEventListener('keydown', onKeyDown);
      };
    });

    const keepPopover = () => clearHideTimer();
    popover.addEventListener('mouseenter', keepPopover);
    popover.addEventListener('mouseleave', scheduleHide);
    const closeDialog = () => dialog.element.close();
    const closeOnBackdrop = (event: MouseEvent) => {
      if (event.target === dialog.element) closeDialog();
    };
    const restoreFocus = () => {
      activeReference?.focus();
      activeReference = null;
    };
    dialog.close.addEventListener('click', closeDialog);
    dialog.element.addEventListener('click', closeOnBackdrop);
    dialog.element.addEventListener('close', restoreFocus);

    return () => {
      cleanupHeadings();
      cleanupDeferredFiles();
      for (const cleanup of cleanups) cleanup();
      clearHideTimer();
      popover.remove();
      if (dialog.element.open) dialog.element.close();
      dialog.element.remove();
    };
  }, [revisionId, targetId]);

  return null;
}

function hydrateDeferredFiles(root: HTMLElement) {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.wiki-file-load[data-wiki-file-src]'));
  const cleanups = buttons.map((button) => {
    const onClick = () => {
      const src = button.dataset.wikiFileSrc;
      if (!src || (!src.startsWith('/') && !src.startsWith('https://'))) return;
      const image = document.createElement('img');
      image.className = 'wiki-file-image';
      image.src = src;
      image.alt = button.dataset.wikiFileAlt ?? '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.style.cssText = button.style.cssText;
      button.replaceWith(image);
    };
    button.addEventListener('click', onClick);
    return () => button.removeEventListener('click', onClick);
  });
  return () => { for (const cleanup of cleanups) cleanup(); };
}

function hydrateHeadingSections(root: HTMLElement, revisionId: string) {
  const headings = Array.from(root.children).filter(
    (element): element is HTMLHeadingElement => /^H[2-6]$/u.test(element.tagName) && Boolean(element.id),
  );
  if (headings.length === 0) return () => undefined;
  const storageKey = `minewiki:wiki:collapsed-headings:${revisionId}`;
  const collapsed = readCollapsedHeadings(storageKey);
  const sections = headings.map((heading) => {
    const nodes: HTMLElement[] = [];
    let sibling = heading.nextElementSibling;
    while (sibling) {
      const siblingLevel = /^H[1-6]$/u.test(sibling.tagName) ? Number(sibling.tagName.slice(1)) : null;
      if (siblingLevel !== null) break;
      nodes.push(sibling as HTMLElement);
      sibling = sibling.nextElementSibling;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wiki-heading-toggle';
    heading.append(button);
    const setCollapsed = (isCollapsed: boolean, persist = true) => {
      for (const node of nodes) node.hidden = isCollapsed;
      button.textContent = isCollapsed ? '+' : '−';
      button.setAttribute('aria-expanded', String(!isCollapsed));
      button.setAttribute('aria-label', `${heading.textContent?.replace(/[+−]$/u, '').trim() || '문단'} ${isCollapsed ? '펼치기' : '접기'}`);
      if (isCollapsed) collapsed.add(heading.id);
      else collapsed.delete(heading.id);
      if (persist) writeCollapsedHeadings(storageKey, collapsed);
    };
    const onClick = () => setCollapsed(!collapsed.has(heading.id));
    button.addEventListener('click', onClick);
    setCollapsed(collapsed.has(heading.id), false);
    return { heading, nodes, button, setCollapsed, onClick };
  });
  const revealHashTarget = () => {
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target || !root.contains(target)) return;
    for (const section of sections) {
      if (section.nodes.some((node) => node === target || node.contains(target))) section.setCollapsed(false);
    }
  };
  window.addEventListener('hashchange', revealHashTarget);
  revealHashTarget();
  return () => {
    window.removeEventListener('hashchange', revealHashTarget);
    for (const section of sections) {
      section.button.removeEventListener('click', section.onClick);
      section.button.remove();
      for (const node of section.nodes) node.hidden = false;
    }
  };
}

function readCollapsedHeadings(storageKey: string): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedHeadings(storageKey: string, collapsed: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
  } catch {
    // Reading remains fully functional when storage is unavailable.
  }
}

function resolveFootnote(root: HTMLElement, reference: HTMLAnchorElement): HTMLLIElement | null {
  const href = reference.getAttribute('href');
  if (!href?.startsWith('#fn-')) return null;
  const note = document.getElementById(href.slice(1));
  return note instanceof HTMLLIElement && root.contains(note) ? note : null;
}

function cloneFootnoteContent(note: HTMLLIElement): DocumentFragment {
  const clone = note.cloneNode(true) as HTMLLIElement;
  clone.querySelector('.wiki-footnote-backlinks')?.remove();
  clone.removeAttribute('id');
  for (const element of Array.from(clone.querySelectorAll<HTMLElement>('[id]'))) element.removeAttribute('id');
  const fragment = document.createDocumentFragment();
  while (clone.firstChild) fragment.append(clone.firstChild);
  return fragment;
}

function positionPopover(popover: HTMLElement, reference: HTMLElement) {
  const referenceRect = reference.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.min(Math.max(12, referenceRect.left), window.innerWidth - width - 12);
  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.min(referenceRect.bottom + 8, window.innerHeight - popover.offsetHeight - 12)}px`;
}

function buildFootnoteDialog() {
  const element = document.createElement('dialog');
  element.className = 'wiki-footnote-dialog';
  element.setAttribute('aria-labelledby', 'wiki-footnote-dialog-title');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'wiki-footnote-dialog-title';
  title.textContent = '각주';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '닫기';
  close.setAttribute('aria-label', '각주 닫기');
  header.append(title, close);
  const content = document.createElement('div');
  content.className = 'wiki-footnote-dialog-content';
  element.append(header, content);
  return { element, close, content };
}
