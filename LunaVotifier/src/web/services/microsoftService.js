const fetch = require('node-fetch');
const config = require('../config');

function getMicrosoftAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.microsoftOAuth.clientId,
    response_type: 'code',
    redirect_uri: config.microsoftOAuth.redirectUri,
    response_mode: 'form_post',
    scope: 'XboxLive.signin offline_access',
    state,
    prompt: 'select_account'
  });

  return `https://login.microsoftonline.com/${config.microsoftOAuth.tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeMicrosoftCode(code) {
  const params = new URLSearchParams({
    client_id: config.microsoftOAuth.clientId,
    client_secret: config.microsoftOAuth.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.microsoftOAuth.redirectUri
  });

  const response = await fetch(`https://login.microsoftonline.com/${config.microsoftOAuth.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!response.ok) {
    throw new Error(`ms_token_failed:${response.status}`);
  }

  return response.json();
}

async function authenticateWithXbox(accessToken) {
  const response = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  });

  if (!response.ok) {
    throw new Error(`xbox_auth_failed:${response.status}`);
  }

  return response.json();
}

async function authorizeXsts(xboxToken) {
  const response = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xboxToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  });

  if (!response.ok) {
    let errorBody = {};
    try {
      errorBody = await response.json();
    } catch (err) {
      errorBody = {};
    }
    const xerr = errorBody?.XErr ? String(errorBody.XErr) : '';
    const error = new Error(`xsts_auth_failed:${response.status}${xerr ? `:${xerr}` : ''}`);
    error.xsts = errorBody;
    throw error;
  }

  return response.json();
}

async function loginWithXbox(xstsToken, userHash) {
  const response = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      identityToken: `XBL3.0 x=${userHash};${xstsToken}`
    })
  });

  if (!response.ok) {
    throw new Error(`mc_login_failed:${response.status}`);
  }

  return response.json();
}

async function fetchMinecraftProfile(mcAccessToken) {
  const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: {
      Authorization: `Bearer ${mcAccessToken}`
    }
  });

  if (response.status === 404) {
    throw new Error('minecraft_profile_not_found');
  }

  if (!response.ok) {
    throw new Error(`minecraft_profile_failed:${response.status}`);
  }

  return response.json();
}

async function verifyMinecraftEntitlements(mcAccessToken) {
  const response = await fetch('https://api.minecraftservices.com/entitlements/mcstore', {
    headers: {
      Authorization: `Bearer ${mcAccessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`minecraft_entitlements_failed:${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('minecraft_entitlements_missing');
  }

  return data.items;
}

function formatUuid(raw) {
  if (!raw) {
    return raw;
  }
  const hex = raw.replace(/-/g, '');
  if (hex.length !== 32) {
    return raw;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function verifyMinecraftOwnership(code) {
  const tokens = await exchangeMicrosoftCode(code);
  const xboxAuth = await authenticateWithXbox(tokens.access_token);
  const xboxToken = xboxAuth.Token;
  const userHash = xboxAuth.DisplayClaims?.xui?.[0]?.uhs;

  if (!xboxToken || !userHash) {
    throw new Error('xbox_claims_missing');
  }

  const xstsAuth = await authorizeXsts(xboxToken);
  const xstsToken = xstsAuth.Token;
  const xstsUserHash = xstsAuth.DisplayClaims?.xui?.[0]?.uhs;

  if (!xstsToken || !xstsUserHash) {
    throw new Error('xsts_claims_missing');
  }

  const mcLogin = await loginWithXbox(xstsToken, xstsUserHash);
  const entitlements = await verifyMinecraftEntitlements(mcLogin.access_token);
  const profile = await fetchMinecraftProfile(mcLogin.access_token);

  return {
    mc_uuid: formatUuid(profile.id),
    mc_ign: profile.name,
    entitlements
  };
}

module.exports = {
  getMicrosoftAuthorizeUrl,
  verifyMinecraftOwnership
};
