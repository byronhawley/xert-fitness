/**
 * Coach file uploads through Supabase Storage. The storage policies (see
 * 20261002020000_staff_roster_coach_dashboard.sql) let a coach write only into
 * their own folder:
 *   - profile photos: public `site-images` bucket, `staff-profiles/<profile id>/…`
 *     (a photo is shown on the website only after a manager approves it);
 *   - certificate files: private `staff-certificates` bucket, `<profile id>/…`,
 *     readable only by that coach and managers, through short-lived links.
 */

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** A picked photo is cropped and shrunk on the device before upload, so big phone photos are fine. */
export const PHOTO_PICK_MAX_BYTES = 30 * 1024 * 1024;
export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;
export const CERTIFICATE_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']);

const safeExtension = (name, fallback) => (String(name || '').split('.').pop() || fallback).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || fallback;
const randomPart = () => globalThis.crypto.randomUUID().slice(0, 8);

/** `staff-profiles/<uid>/<time>-<random>.<ext>` */
export function profilePhotoPath(uid, fileName, now = Date.now()) {
  return `staff-profiles/${uid}/${now}-${randomPart()}.${safeExtension(fileName, 'jpg')}`;
}

/** `<uid>/<time>-<random>.<ext>`; the database accepts only this shape. */
export function certificateFilePath(uid, fileName, now = Date.now()) {
  return `${uid}/${now}-${randomPart()}.${safeExtension(fileName, 'pdf')}`;
}

/** Plain-words check before uploading; null when the file is fine. */
export function fileProblem(file, kind) {
  if (!file) return 'Choose a file.';
  if (kind === 'photo' || kind === 'photo-pick') {
    if (!String(file.type).startsWith('image/')) return 'Choose an image file.';
    if (kind === 'photo-pick' && file.size > PHOTO_PICK_MAX_BYTES) return 'That photo is too big. Choose one under 30 MB.';
    if (kind === 'photo' && file.size > PHOTO_MAX_BYTES) return 'Photos must be under 5 MB.';
  } else {
    if (!CERTIFICATE_TYPES.includes(file.type)) return 'Upload a PDF or a photo (JPG, PNG, HEIC).';
    if (file.size > CERTIFICATE_MAX_BYTES) return 'Files must be under 10 MB.';
  }
  return null;
}

export function createStaffFiles(storage) {
  return {
    /** `file` may be a picked File or the cropper's JPEG Blob (no name, so it is stored as .jpg). */
    async uploadProfilePhoto(uid, file) {
      const problem = fileProblem(file, 'photo');
      if (problem) throw new Error(problem);
      const path = profilePhotoPath(uid, file.name);
      const { error } = await storage.from('site-images').upload(path, file, { cacheControl: '31536000', upsert: false, contentType: file.type });
      if (error) throw new Error(error.message || 'Upload failed.');
      return storage.from('site-images').getPublicUrl(path).data.publicUrl;
    },
    async uploadCertificateFile(uid, file) {
      const problem = fileProblem(file, 'certificate');
      if (problem) throw new Error(problem);
      const path = certificateFilePath(uid, file.name);
      const { error } = await storage.from('staff-certificates').upload(path, file, { upsert: false, contentType: file.type });
      if (error) throw new Error(error.message || 'Upload failed.');
      return path;
    },
    async certificateFileUrl(path) {
      const { data, error } = await storage.from('staff-certificates').createSignedUrl(path, 60);
      if (error) throw new Error(error.message || 'Could not open the file.');
      return data.signedUrl;
    },
    async removeCertificateFile(path) {
      if (!path) return;
      await storage.from('staff-certificates').remove([path]);
    },
  };
}

let defaultFiles = null;
export async function staffFiles() {
  if (!defaultFiles) {
    const { supabase } = await import('./supabase.js');
    defaultFiles = createStaffFiles(supabase.storage);
  }
  return defaultFiles;
}
