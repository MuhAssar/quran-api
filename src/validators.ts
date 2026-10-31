import { HTTPException } from 'hono/http-exception';

export function assertInt(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') {
    throw new HTTPException(400, { message: `missing ${name}\n` });
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HTTPException(400, {
      message: `invalid ${name}: ${value} (expected integer in [${min}, ${max}])\n`,
    });
  }
  return n;
}

export function assertBookCode(
  value: string | undefined,
  bookCodes: ReadonlySet<string>,
): string {
  if (!value) {
    throw new HTTPException(400, { message: 'missing bookCode\n' });
  }
  if (!bookCodes.has(value)) {
    throw new HTTPException(400, {
      message: `unknown bookCode: ${value}\n`,
    });
  }
  return value;
}
