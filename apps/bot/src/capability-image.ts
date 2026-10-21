import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { stitchImages } from '../../../packages/image-compose/src/index.js';

export interface ImageStitchHandlerOptions {
  getConfig: () => AppConfig;
  generatedFileDir: string;
  uploadFile: (localPath: string, name: string, mime: string) => Promise<string>;
}

async function imageReferenceToBuffer(value: string): Promise<Buffer> {
  const ref = String(value || '').trim();
  if (!ref) throw new Error('empty_image_reference');
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    if (comma < 0) throw new Error('invalid_data_url');
    return Buffer.from(ref.slice(comma + 1), 'base64');
  }
  if (ref.startsWith('base64://')) return Buffer.from(ref.slice('base64://'.length), 'base64');
  if (ref.startsWith('file://')) {
    const raw = decodeURIComponent(ref.slice('file://'.length));
    const filePath = process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(raw) ? raw.slice(1) : raw;
    return fs.readFile(filePath);
  }
  if (/^https?:\/\//i.test(ref)) {
    const response = await fetch(ref);
    if (!response.ok) throw new Error(`image_fetch_${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFile(ref);
}

export class ImageStitchCapabilityHandler implements CapabilityHandler {
  constructor(private readonly options: ImageStitchHandlerOptions) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const args = invocation.step.args || {};
    const refs = Array.isArray(args.images)
      ? args.images.map(String).filter(Boolean)
      : (invocation.request.attachments || []).filter((item: any) => item.kind === 'image').map((item: any) => String(item.ref || item.url || ''));
    if (refs.length < 2) {
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'needs_input', outputs: [],
        diagnostics: { question: '请至少发送两张图片，并说明需要拼接。' },
      };
    }
    const buffers = await Promise.all(refs.slice(0, 8).map(imageReferenceToBuffer));
    const cfg = this.options.getConfig();
    const comfyNode = cfg.llm.apiKeys.find((node) => node.comfyui?.profiles?.length);
    const stitchConfig = comfyNode?.comfyui?.profiles.find((profile) => profile.stitch)?.stitch || { quality: 80 };
    const composed = await stitchImages(buffers, stitchConfig);
    await fs.mkdir(this.options.generatedFileDir, { recursive: true });
    const filePath = path.join(this.options.generatedFileDir, `stitch-${Date.now()}.png`);
    await fs.writeFile(filePath, composed.buffer);
    const url = await this.options.uploadFile(filePath, path.basename(filePath), 'image/png');
    return {
      jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
      outputs: [{ kind: 'image', url, priority: 9, mergeable: true, meta: { width: composed.width, height: composed.height } }],
    };
  }
}
