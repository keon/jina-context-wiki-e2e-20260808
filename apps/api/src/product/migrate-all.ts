import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dbMigration = join(dirname(require.resolve("@jina/db")), "migrate.js");
const productMigration = fileURLToPath(new URL("./migrate.js", import.meta.url));

await run(process.execPath, [dbMigration, ...process.argv.slice(2)]);
await run(process.execPath, [productMigration]);
console.log("unified v2 database migrations complete");

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}
