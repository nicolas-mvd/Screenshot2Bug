import type { CaptureSession, EvidenceAttachment } from "./types";
import type { IssueScreenshotLink } from "./github";

export interface CloudinaryUploadSettings {
  cloudName: string;
  uploadPreset: string;
}

interface CloudinaryUploadResponse {
  public_id: string;
  secure_url: string;
}

export async function uploadCloudinaryScreenshots({
  settings,
  session
}: {
  settings: CloudinaryUploadSettings;
  session: Pick<CaptureSession, "screenshots">;
}): Promise<{
  screenshots: EvidenceAttachment[];
  links: IssueScreenshotLink[];
}> {
  const cloudName = settings.cloudName.trim();
  const uploadPreset = settings.uploadPreset.trim();
  if (!cloudName || !uploadPreset) {
    throw new Error("Add a Cloudinary cloud name and unsigned upload preset in Settings first.");
  }

  const screenshots = session.screenshots ?? [];
  const updatedScreenshots: EvidenceAttachment[] = [];
  const links: IssueScreenshotLink[] = [];

  for (const [index, screenshot] of screenshots.entries()) {
    const label = `Screenshot ${index + 1}`;
    const existing = screenshot.upload;
    if (
      existing?.provider === "cloudinary" &&
      existing.cloudName === cloudName &&
      existing.uploadPreset === uploadPreset &&
      existing.markdownUrl
    ) {
      updatedScreenshots.push(screenshot);
      links.push({
        screenshotId: screenshot.id,
        label,
        markdownUrl: existing.markdownUrl,
        path: existing.publicId
      });
      continue;
    }

    const uploaded = await uploadCloudinaryImage({
      cloudName,
      uploadPreset,
      dataUrl: screenshot.dataUrl
    });
    const upload = {
      provider: "cloudinary" as const,
      cloudName,
      uploadPreset,
      publicId: uploaded.public_id,
      secureUrl: uploaded.secure_url,
      markdownUrl: uploaded.secure_url,
      uploadedAt: new Date().toISOString()
    };
    const updated = { ...screenshot, upload };
    updatedScreenshots.push(updated);
    links.push({
      screenshotId: screenshot.id,
      label,
      markdownUrl: upload.markdownUrl,
      path: upload.publicId
    });
  }

  return { screenshots: updatedScreenshots, links };
}

async function uploadCloudinaryImage({
  cloudName,
  uploadPreset,
  dataUrl
}: {
  cloudName: string;
  uploadPreset: string;
  dataUrl: string;
}): Promise<CloudinaryUploadResponse> {
  const form = new FormData();
  form.set("file", dataUrl);
  form.set("upload_preset", uploadPreset);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    {
      method: "POST",
      body: form
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Cloudinary upload failed with ${response.status}`);
  }
  if (!data.secure_url || !data.public_id) {
    throw new Error("Cloudinary upload did not return an image URL.");
  }
  return data;
}
