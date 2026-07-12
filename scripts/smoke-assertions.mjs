export function matchesJsonSubset(actual, expected) {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return false;
  }
  return Object.entries(expected).every(([key, value]) =>
    matchesJsonSubset(actual[key], value),
  );
}
