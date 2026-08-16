import { describe, it, expect } from 'vitest';
import { readCreateArgs } from '../src/discovery/rpc.js';

/**
 * The pump.fun create instruction carries the launch's name, symbol and
 * metadata URI as Borsh strings after the Anchor discriminator. Nothing else in
 * the transaction has them, and without them the safety battery is judging a
 * launch it cannot see — `metadata_sanity` fails for having no name (-35) and
 * `socials` fails for having no URI (-20), which put every launch off this feed
 * at 45 against a threshold of 70.
 */

const DISCRIMINATOR = Buffer.alloc(8);

function borshString(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

function createIxData(name: string, symbol: string, uri: string, trailing = Buffer.alloc(32)) {
  return Uint8Array.from(
    Buffer.concat([
      DISCRIMINATOR,
      borshString(name),
      borshString(symbol),
      borshString(uri),
      trailing, // the creator pubkey later program versions append
    ]),
  );
}

describe('pump.fun create instruction arguments', () => {
  it('reads the three fields the safety battery needs', () => {
    const data = createIxData('Test Token', 'TEST', 'https://ipfs.io/ipfs/abc');
    expect(readCreateArgs(data)).toEqual({
      name: 'Test Token',
      symbol: 'TEST',
      uri: 'https://ipfs.io/ipfs/abc',
    });
  });

  it('handles multi-byte characters without splitting them', () => {
    // The length prefix counts bytes, not characters. Getting that wrong
    // corrupts every emoji ticker on pump.fun, which is most of them.
    const data = createIxData('Solana 🚀', '🚀SOL', 'https://arweave.net/x');
    const args = readCreateArgs(data);
    expect(args.name).toBe('Solana 🚀');
    expect(args.symbol).toBe('🚀SOL');
  });

  it('reads an empty string as empty rather than falling over', () => {
    const data = createIxData('', '', '');
    expect(readCreateArgs(data)).toEqual({ name: '', symbol: '', uri: '' });
  });

  it('refuses a length prefix that claims more than the buffer holds', () => {
    // The prefix comes off the wire, so it is a claim rather than a fact.
    const lying = Buffer.alloc(4);
    lying.writeUInt32LE(99, 0);
    const data = Uint8Array.from(Buffer.concat([DISCRIMINATOR, lying, Buffer.from('short')]));
    expect(readCreateArgs(data)).toEqual({});
  });

  it('refuses an absurd length rather than trying to allocate it', () => {
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(0xffffffff, 0);
    const data = Uint8Array.from(Buffer.concat([DISCRIMINATOR, huge]));
    expect(readCreateArgs(data)).toEqual({});
  });

  it('returns what it could read when the data is cut short', () => {
    // Partial is better than nothing: a name still lets metadata_sanity work.
    const data = Uint8Array.from(
      Buffer.concat([DISCRIMINATOR, borshString('Half A Token'), borshString('HALF')]),
    );
    expect(readCreateArgs(data)).toEqual({ name: 'Half A Token', symbol: 'HALF' });
  });

  it('survives data too short to hold anything at all', () => {
    expect(readCreateArgs(Uint8Array.from(DISCRIMINATOR))).toEqual({});
    expect(readCreateArgs(new Uint8Array(0))).toEqual({});
  });

  it('reads from a view that does not start at the buffer origin', () => {
    // web3.js hands over instruction data as a subarray of a larger buffer, so
    // reading the u32 through the underlying ArrayBuffer without accounting for
    // byteOffset would decode a neighbouring instruction's bytes.
    const framed = Buffer.concat([
      Buffer.from('LEADINGJUNK'),
      Buffer.from(createIxData('Offset', 'OFF', 'https://ipfs.io/ipfs/z')),
    ]);
    const view = new Uint8Array(
      framed.buffer,
      framed.byteOffset + 11,
      framed.byteLength - 11,
    );
    expect(readCreateArgs(view)).toEqual({
      name: 'Offset',
      symbol: 'OFF',
      uri: 'https://ipfs.io/ipfs/z',
    });
  });
});
