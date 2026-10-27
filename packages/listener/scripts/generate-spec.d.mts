export const specDirectory: string;
export function serialize(value: unknown): string;
export function generateSpec(): Map<string, string>;
export function diskFiles(directory?: string, prefix?: string): Promise<string[]>;
export function checkSpec(): Promise<void>;
