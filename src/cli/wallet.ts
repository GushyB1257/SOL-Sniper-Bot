/**
 * Generates a fresh burner keypair for the bot.
 *
 *   npm run wallet
 *
 * Deliberately prints to stdout rather than writing a file, so the key only
 * lands where you choose to put it.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();

console.log('\nNew burner wallet\n');
console.log(`  Public key   ${kp.publicKey.toBase58()}`);
console.log(`  Private key  ${bs58.encode(kp.secretKey)}`);
console.log(`
Put the private key in .env as WALLET_PRIVATE_KEY, then fund the public key.

  - Fund it with an amount you are willing to lose outright. This key lives in
    a plaintext file on a machine running networked code; treat it as already
    compromised and keep the balance at the size of your intended float.
  - Do not reuse a wallet that holds anything else.
  - .env is gitignored, but check before you commit anyway.
`);
