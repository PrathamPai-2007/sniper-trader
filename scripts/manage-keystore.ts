import fs from 'node:fs';
import readline from 'node:readline';
import { encrypt } from '../src/core/keystore.js';

async function prompt(query: string, hide = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
    if (hide) {
      const rlExt = rl as unknown as {
        output: NodeJS.WritableStream;
        _writeToOutput: (s: string) => void;
      };
      rlExt._writeToOutput = (s: string) => {
        if (s === '\n' || s === '\r' || s === '\r\n') rlExt.output.write(s);
      };
    }
  });
}

async function main() {
  console.log('--- Veloci-Buy Keystore Manager ---');
  const privateKey = await prompt('Enter raw Private Key (Base58 or [1,2,3] array): ', true);
  console.log('');
  const password = await prompt('Enter password to encrypt keystore: ', true);
  console.log('');
  const confirm = await prompt('Confirm password: ', true);
  console.log('');

  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const outputPath = await prompt('Enter output path (e.g., wallet.json): ');

  try {
    const encrypted = await encrypt(privateKey, password);
    fs.writeFileSync(outputPath, JSON.stringify(encrypted, null, 2));
    console.log(`Successfully created keystore at ${outputPath}`);
  } catch (err) {
    console.error('Failed to create keystore:', err);
    process.exit(1);
  }
}

main();
