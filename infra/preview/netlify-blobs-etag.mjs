// Netlify CLI's bundled local Blobs server 10.7.13 omits the ETag on GET,
// although its conditional PUT returns one and checks If-Match against it.
// The production SDK needs that GET ETag to confirm CAS writes. Repair only
// the disposable CLI process; production functions remain unchanged.
import { pathToFileURL } from 'node:url';

export function repairLocalBlobsEtag(BlobsServer) {
  const original = BlobsServer.prototype.get;
  if (typeof original !== 'function' || typeof BlobsServer.generateETag !== 'function') {
    throw new Error('Unsupported local Blobs server');
  }
  BlobsServer.prototype.get = async function getWithEtag(request) {
    const response = await original.call(this, request);
    if (response.status !== 200) return response;
    const url = this.parseAPIRequest(request)?.url ?? new URL(request.url, this.address);
    const { dataPath, key } = this.getLocalPaths(url);
    if (!dataPath || !key) return response;
    const etag = await BlobsServer.generateETag(dataPath);
    if (!etag) return response;
    const headers = new Headers(response.headers);
    headers.set('etag', etag);
    return new Response(response.body, { status: response.status, headers });
  };
}

if (process.env.KHALA_LOCAL_NETLIFY_BLOBS_SERVER) {
  const { BlobsServer } = await import(pathToFileURL(process.env.KHALA_LOCAL_NETLIFY_BLOBS_SERVER).href);
  repairLocalBlobsEtag(BlobsServer);
}
