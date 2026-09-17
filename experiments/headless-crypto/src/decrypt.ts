/** Native0.4 reports missing Megolm keys through this exact NAPI error shape. */
export function isMissingRoomKey(error: unknown): boolean {
  return error instanceof Error && (error as Error & {code?:string}).code === 'GenericFailure'
    && /^Can't find the room key to decrypt the event, withheld code: (None|Some\(Unverified\))$/.test(error.message);
}

export async function decryptWithKeyRetry<T>(
  fetchEvent: () => Promise<{type?:string}>,
  decrypt: (event: {type?:string}) => Promise<T>,
  attempts: number,
  delay = () => new Promise(resolve => setTimeout(resolve, 200)),
): Promise<T> {
  // Transport failures and plaintext responses can never satisfy missing-key evidence.
  const event = await fetchEvent();
  if(event.type !== 'm.room.encrypted') throw new Error('server stored plaintext');
  for(let index=0;index<attempts;index++) {
    try { return await decrypt(event); }
    catch(error) {
      if(!isMissingRoomKey(error)) throw error;
      if(index === attempts-1) throw new Error('native missing room key after retry');
      await delay();
    }
  }
  throw new Error('positive retry count required');
}
