import { getGitLabContext } from '../utils/gitlab';

export default defineEventHandler(async event => {
  const query = getQuery(event);
  if (typeof query.mrUrl !== 'string' || typeof query.imageUrl !== 'string') throw createError({ statusCode: 400, statusMessage: 'Merge request and image URLs are required' });
  const { mr, account } = await getGitLabContext(event, query.mrUrl);
  let image: URL;
  try { image = new URL(query.imageUrl); } catch { throw createError({ statusCode: 400, statusMessage: 'Invalid image URL' }); }
  const isUpload = image.pathname.startsWith('/uploads/') || image.pathname.startsWith(`/api/v4/projects/${mr.encodedProject}/uploads/`);
  if (image.origin !== mr.host || image.username || image.password || !isUpload) throw createError({ statusCode: 403, statusMessage: 'Only images uploaded to this GitLab project can be loaded' });
  const response = await fetch(image, { headers: { Authorization: `Bearer ${account.token}` }, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw createError({ statusCode: 502, statusMessage: 'GitLab redirected the image request' });
  if (!response.ok) throw createError({ statusCode: response.status, statusMessage: `GitLab could not load the image (${response.status})` });
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(contentType)) throw createError({ statusCode: 415, statusMessage: 'GitLab upload is not a supported image' });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10 * 1024 * 1024) throw createError({ statusCode: 413, statusMessage: 'Image exceeds the 10 MB limit' });
  setResponseHeader(event, 'Content-Type', contentType);
  setResponseHeader(event, 'Cache-Control', 'private, max-age=60');
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  return bytes;
});
