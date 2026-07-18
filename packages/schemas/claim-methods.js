'use strict';

const SUPPORTED_CLAIM_METHODS = Object.freeze(['dns', 'motd']);

function isSupportedClaimMethod(value) {
  return SUPPORTED_CLAIM_METHODS.includes(value);
}

module.exports = {
  SUPPORTED_CLAIM_METHODS,
  isSupportedClaimMethod,
};
