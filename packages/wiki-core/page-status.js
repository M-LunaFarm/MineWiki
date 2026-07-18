'use strict';

const PUBLIC_WIKI_PAGE_STATUSES = Object.freeze(['normal', 'active', 'published', 'protected']);
const PUBLIC_WIKI_PAGE_STATUS_SQL_LIST = PUBLIC_WIKI_PAGE_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');

function isPublicWikiPageStatus(status) {
  return PUBLIC_WIKI_PAGE_STATUSES.includes(status);
}

module.exports = {
  PUBLIC_WIKI_PAGE_STATUSES,
  PUBLIC_WIKI_PAGE_STATUS_SQL_LIST,
  isPublicWikiPageStatus,
};
