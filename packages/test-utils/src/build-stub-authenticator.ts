import { createHash, randomBytes } from 'node:crypto';

// The parts of the creation and request options a browser passes to
// navigator.credentials that an authenticator reads.
interface CreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
  readonly user: { readonly id: string };
}

interface RequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

// What a browser and its authenticator put in a response, each defaulting
// to the honest value: the page's origin as given, the RP ID the options
// hold, and a verified user.
interface Ceremony {
  readonly origin: string;
  readonly rpID?: string;
  readonly userVerified?: boolean;
}

export interface StubRegistration {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports: readonly string[];
  };
  readonly clientExtensionResults: Readonly<Record<string, never>>;
  readonly authenticatorAttachment: 'platform';
}

export interface StubAssertion {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle: string;
  };
  readonly clientExtensionResults: Readonly<Record<string, never>>;
}

export function buildStubAuthenticator() {
  const credentialID = randomBytes(16);

  const keys = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  let userHandle: string | null = null;
  let counter = 0;

  return {
    credentialID: credentialID.toString('base64url'),
    async create(options: CreationOptions, ceremony: Ceremony): Promise<StubRegistration> {
      const pair = await keys;
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

      userHandle = options.user.id;

      // A COSE EC2 key: kty 2, alg -7 (ES256), crv 1 (P-256), x, y.
      const coseKey = encodeCBOR(
        new Map<number, CBORValue>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x ?? '', 'base64url')],
          [-3, Buffer.from(jwk.y ?? '', 'base64url')],
        ]),
      );

      const length = Buffer.alloc(2);

      length.writeUInt16BE(credentialID.length);

      const authData = Buffer.concat([
        buildAuthenticatorHeader(ceremony.rpID ?? options.rp.id ?? '', ceremony, 0, FLAG_AT),
        Buffer.alloc(16),
        length,
        credentialID,
        coseKey,
      ]);

      const attestationObject = encodeCBOR(
        new Map<string, CBORValue>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );

      return {
        id: credentialID.toString('base64url'),
        rawId: credentialID.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: buildClientData('webauthn.create', options.challenge, ceremony),
          attestationObject: attestationObject.toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    async signAssertion(options: RequestOptions, ceremony: Ceremony): Promise<StubAssertion> {
      if (userHandle === null) {
        throw new Error('the stub authenticator holds no credential yet');
      }

      const pair = await keys;

      counter += 1;

      const authenticatorData = buildAuthenticatorHeader(
        ceremony.rpID ?? options.rpId ?? '',
        ceremony,
        counter,
        0,
      );

      const clientDataJSON = buildClientData('webauthn.get', options.challenge, ceremony);

      const signed = Buffer.concat([
        authenticatorData,
        createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest(),
      ]);

      const raw = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        signed,
      );

      return {
        id: credentialID.toString('base64url'),
        rawId: credentialID.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON,
          authenticatorData: authenticatorData.toString('base64url'),
          signature: toDERSignature(Buffer.from(raw)).toString('base64url'),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// The RP ID hash, the flags with user presence always set, and the
// big-endian signature counter.
function buildAuthenticatorHeader(
  rpID: string,
  ceremony: Ceremony,
  signCount: number,
  extraFlags: number,
): Buffer {
  const flags = FLAG_UP | (ceremony.userVerified === false ? 0 : FLAG_UV) | extraFlags;
  const count = Buffer.alloc(4);

  count.writeUInt32BE(signCount);

  return Buffer.concat([createHash('sha256').update(rpID).digest(), Buffer.from([flags]), count]);
}

function buildClientData(type: string, challenge: string, ceremony: Ceremony): string {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin: ceremony.origin, crossOrigin: false }),
  ).toString('base64url');
}

// WebCrypto signs ECDSA as r and s side by side; WebAuthn carries the
// signature as an ASN.1 DER sequence of two integers.
function toDERSignature(raw: Buffer): Buffer {
  const integers = [raw.subarray(0, 32), raw.subarray(32)].map((part) => {
    const start = part.findIndex((byte) => byte !== 0);
    const trimmed = start === -1 ? Buffer.from([0]) : part.subarray(start);
    const value = (trimmed[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;

    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  });

  const body = Buffer.concat(integers);

  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

type CBORValue = number | string | Buffer | ReadonlyMap<number | string, CBORValue>;

// The CBOR subset a COSE key and a `none` attestation need: integers,
// byte strings, text strings, and maps.
function encodeCBOR(value: CBORValue): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? encodeCBORHead(0, value) : encodeCBORHead(1, -1 - value);
  }

  if (typeof value === 'string') {
    const text = Buffer.from(value);

    return Buffer.concat([encodeCBORHead(3, text.length), text]);
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.concat([encodeCBORHead(2, value.length), value]);
  }

  return Buffer.concat([
    encodeCBORHead(5, value.size),
    ...[...value].flatMap(([key, item]) => [encodeCBOR(key), encodeCBOR(item)]),
  ]);
}

function encodeCBORHead(major: number, length: number): Buffer {
  if (length < 24) {
    return Buffer.from([(major << 5) | length]);
  }

  if (length < 256) {
    return Buffer.from([(major << 5) | 24, length]);
  }

  const head = Buffer.alloc(3);

  head.writeUInt8((major << 5) | 25);
  head.writeUInt16BE(length, 1);

  return head;
}
