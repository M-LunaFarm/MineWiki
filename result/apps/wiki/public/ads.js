const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const hostname = window.location.hostname;
const isPrivateHost =
  blockedHosts.has(hostname) ||
  hostname.endsWith('.local') ||
  /^10\./.test(hostname) ||
  /^192\.168\./.test(hostname) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

if (!isPrivateHost && window.location.protocol === 'https:') {
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5274837993879523';
  script.crossOrigin = 'anonymous';
  document.head.append(script);
}
