export function print(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

export function printError(message: string): void {
  console.error(`Error: ${message}`);
}

export function handleError(err: unknown, json: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}
