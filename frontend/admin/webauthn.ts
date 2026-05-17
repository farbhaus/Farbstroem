// Minimal glue between webauthn-rs's JSON wire format and the browser
// WebAuthn API. webauthn-rs serializes binary fields as unpadded base64url
// strings; navigator.credentials.{create,get} need ArrayBuffers, and the
// result must be re-encoded back to base64url for the server. No dependency.

function b64urlToBuf(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufToB64url(b: ArrayBuffer): string {
  const bytes = new Uint8Array(b);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface CredDescriptor {
  id: string;
  type: string;
  transports?: string[];
}

// Decode the `publicKey` of a webauthn-rs CreationChallengeResponse in place
// (challenge, user.id, excludeCredentials[].id) into ArrayBuffers.
export async function doRegister(options: any): Promise<unknown> {
  const pk = options.publicKey;
  pk.challenge = b64urlToBuf(pk.challenge);
  pk.user.id = b64urlToBuf(pk.user.id);
  if (pk.excludeCredentials) {
    pk.excludeCredentials = pk.excludeCredentials.map((c: CredDescriptor) => ({
      ...c,
      id: b64urlToBuf(c.id),
    }));
  }
  const cred = (await navigator.credentials.create({ publicKey: pk })) as PublicKeyCredential;
  const resp = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    extensions: cred.getClientExtensionResults(),
    response: {
      attestationObject: bufToB64url(resp.attestationObject),
      clientDataJSON: bufToB64url(resp.clientDataJSON),
    },
  };
}

// Same for a webauthn-rs RequestChallengeResponse / assertion.
export async function doAuthenticate(options: any): Promise<unknown> {
  const pk = options.publicKey;
  pk.challenge = b64urlToBuf(pk.challenge);
  if (pk.allowCredentials) {
    pk.allowCredentials = pk.allowCredentials.map((c: CredDescriptor) => ({
      ...c,
      id: b64urlToBuf(c.id),
    }));
  }
  const cred = (await navigator.credentials.get({ publicKey: pk })) as PublicKeyCredential;
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    extensions: cred.getClientExtensionResults(),
    response: {
      authenticatorData: bufToB64url(resp.authenticatorData),
      clientDataJSON: bufToB64url(resp.clientDataJSON),
      signature: bufToB64url(resp.signature),
      userHandle: resp.userHandle ? bufToB64url(resp.userHandle) : null,
    },
  };
}

export function webauthnSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}
