'use strict';
// Stores rendered print files where Printify can download them (Vercel Blob, public, unguessable store URL).
// Needs BLOB_READ_WRITE_TOKEN, which Vercel adds when a Blob store is connected to the project.
async function putPrintFile(pathname, buffer, contentType, { env = process.env, putImpl } = {}) {
  if (!putImpl && !env.BLOB_READ_WRITE_TOKEN) throw new Error('storage_not_configured: connect a Vercel Blob store (BLOB_READ_WRITE_TOKEN)');
  const put = putImpl || require('@vercel/blob').put;
  const blob = await put(pathname, buffer, {
    access: 'public', contentType, addRandomSuffix: true, multipart: buffer.length > 8 * 1024 * 1024,
    cacheControlMaxAge: 60 * 60 * 24 * 365
  });
  return blob.url;
}
module.exports = { putPrintFile };
