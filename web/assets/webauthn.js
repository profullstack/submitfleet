// Minimal WebAuthn JSON helpers (the shapes @simplewebauthn/server expects), so no CDN is needed.
const b64u = {
  toBuf(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  },
  fromBuf(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
};

export const passkeysSupported = () => typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;

export async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: b64u.toBuf(options.challenge),
    user: { ...options.user, id: b64u.toBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: b64u.fromBuf(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b64u.fromBuf(r.clientDataJSON),
      attestationObject: b64u.fromBuf(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

export async function getPasskey(options, mediation) {
  const publicKey = {
    ...options,
    challenge: b64u.toBuf(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey, ...(mediation ? { mediation } : {}) });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: b64u.fromBuf(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b64u.fromBuf(r.clientDataJSON),
      authenticatorData: b64u.fromBuf(r.authenticatorData),
      signature: b64u.fromBuf(r.signature),
      userHandle: r.userHandle ? b64u.fromBuf(r.userHandle) : undefined,
    },
  };
}
