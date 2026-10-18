# ComfyUI：MOSS-Image、Krea 2 与 Z-Image 适配

这两个模型都不建议使用 SD1.5 式权重语法。它们的 PromptPolicy 默认已关闭权重、BREAK、`<lora:...>` 标签和动态提示词，只保留自然语言提示词。

## 1. MOSS-Image

官方建议：

- 英文自然语言优先，中文也支持。
- 支持 caption、tag sequence 和 Layout JSON。
- 推荐分辨率：1M、1.5M、2M 总像素，宽高为 16 的倍数。
- Base：50 步以上，CFG 3.0（推荐 3.0-6.0），shift 5.0，Euler，sgm_uniform。
- 推荐负向提示词：`nsfw, worst quality, bad anatomy, watermark, jpeg artifact`。
- 文本编码上限约 4096 tokens。

推荐 Profile 片段：

```json
{
  "id": "moss-image-sft",
  "name": "MOSS-Image SFT",
  "promptPolicy": {
    "modelFamily": "moss-image",
    "variant": "sft",
    "promptSyntax": "moss",
    "language": "en",
    "preferredFormat": "caption",
    "supportsWeights": false,
    "supportsNegativePrompt": true,
    "supportsBreak": false,
    "supportsEmbeddings": false,
    "supportsDynamicPrompts": false,
    "supportsLoraTags": false,
    "maxPromptChars": 4000,
    "maxWeights": 0,
    "weightMin": 1,
    "weightMax": 1,
    "defaultNegativePrompt": "nsfw, worst quality, bad anatomy, watermark, jpeg artifact",
    "loraTriggers": []
  },
  "defaults": {
    "prompt": "",
    "negativePrompt": "nsfw, worst quality, bad anatomy, watermark, jpeg artifact",
    "width": 1024,
    "height": 1024,
    "steps": 50,
    "cfg": 3,
    "shift": 5,
    "sampler": "euler",
    "scheduler": "sgm_uniform",
    "seed": 0,
    "batchSize": 1
  },
  "constraints": {
    "width": { "type": "number", "min": 256, "max": 2048 },
    "height": { "type": "number", "min": 256, "max": 2048 },
    "steps": { "type": "number", "min": 20, "max": 100 },
    "cfg": { "type": "number", "min": 3, "max": 6 },
    "batchSize": { "type": "number", "min": 1, "max": 4 }
  }
}
```

`parameterMap`、`workflow` 和 `outputNodeId` 需要按你的 API workflow 填写。MOSS 原生 ComfyUI 节点和示例 API workflow 可参考 OpenMOSS 仓库的 `comfyui/README.md`。

## 2. Krea 2

Krea 2 的官方建议：

- 使用自然语言，长而具体的描述效果最好。
- 不需要 SD 式质量词堆砌。
- 要显示的文字用引号括起来。
- Turbo：8 步、CFG 0、`mu` 约 1.15，支持 1K 到 2K。
- Raw：约 52 步、CFG 3.5，主要用于训练和二次开发。
- Turbo 默认不使用负向提示词。

推荐 Profile 片段：

```json
{
  "id": "krea-2-turbo",
  "name": "Krea 2 Turbo",
  "promptPolicy": {
    "modelFamily": "krea-2",
    "variant": "turbo",
    "promptSyntax": "krea",
    "language": "en",
    "preferredFormat": "caption",
    "supportsWeights": false,
    "supportsNegativePrompt": false,
    "supportsBreak": false,
    "supportsEmbeddings": false,
    "supportsDynamicPrompts": false,
    "supportsLoraTags": false,
    "maxPromptChars": 2000,
    "maxWeights": 0,
    "weightMin": 1,
    "weightMax": 1,
    "defaultNegativePrompt": "",
    "loraTriggers": []
  },
  "defaults": {
    "prompt": "",
    "width": 1024,
    "height": 1024,
    "steps": 8,
    "cfg": 0,
    "mu": 1.15,
    "seed": 0,
    "batchSize": 1
  },
  "constraints": {
    "width": { "type": "number", "min": 512, "max": 2048 },
    "height": { "type": "number", "min": 512, "max": 2048 },
    "steps": { "type": "number", "min": 8, "max": 8 },
    "cfg": { "type": "number", "min": 0, "max": 1 }
  }
}
```

Krea Raw 可以把 `variant` 改成 `raw`，默认参数改为：

```json
{
  "steps": 52,
  "cfg": 3.5,
  "width": 1024,
  "height": 1024
}
```

`mu`、`sampler`、`scheduler` 等字段是否存在于 parameterMap，以实际 ComfyUI 工作流为准。

## 3. 提示词策略自动推断

Profile 没有显式写 `promptPolicy` 时，会根据 `id` / `name` 推断：

- id/name 包含 `moss`：MOSS-Image 策略
- id/name 包含 `krea-2` / `krea2`：Krea 2 策略
- 其他未知模型：保持通用兼容模式

建议还是显式填写 `promptPolicy`，尤其是同一节点有多个不同模型 Profile 时。

## 4. 参数映射注意

`parameterMap` 的路径必须是 ComfyUI **API Format workflow** 的实际路径，例如：

```json
{
  "prompt": "6.inputs.text",
  "negativePrompt": "7.inputs.text",
  "width": "5.inputs.width",
  "height": "5.inputs.height",
  "steps": "3.inputs.steps",
  "cfg": "3.inputs.cfg",
  "sampler": "3.inputs.sampler_name",
  "scheduler": "3.inputs.scheduler",
  "seed": "3.inputs.seed",
  "batchSize": "5.inputs.batch_size"
}
```

如果 Krea 工作流还使用 `mu`、`shift`、`guidance` 或 `denoise`，把对应字段加入 `parameterMap`，转换模型才会输出和写入这些参数。

## 3. Z-Image Turbo

实际测试使用的工作流参数：

```text
UNETLoader: z_image_turbo_bf16.safetensors
CLIPLoader: qwen_3_4b.safetensors / lumina2
VAELoader: ae.safetensors
KSampler: steps 9, cfg 1, res_multistep, simple
ModelSamplingAuraFlow: shift 3
```

Z-Image 使用自然语言提示词，不使用权重、BREAK 或 LoRA 标签。推荐 Profile：

```json
{
  "id": "z-image-turbo",
  "name": "Z-Image Turbo",
  "promptPolicy": {
    "modelFamily": "z-image",
    "variant": "turbo",
    "promptSyntax": "natural",
    "language": "en",
    "preferredFormat": "caption",
    "supportsWeights": false,
    "supportsNegativePrompt": false,
    "supportsBreak": false,
    "supportsEmbeddings": false,
    "supportsDynamicPrompts": false,
    "supportsLoraTags": false,
    "maxPromptChars": 2000,
    "maxWeights": 0,
    "weightMin": 1,
    "weightMax": 1,
    "defaultNegativePrompt": "",
    "loraTriggers": []
  },
  "defaults": {
    "prompt": "",
    "width": 1024,
    "height": 1024,
    "steps": 9,
    "cfg": 1,
    "sampler": "res_multistep",
    "scheduler": "simple",
    "shift": 3,
    "seed": 0,
    "batchSize": 1
  }
}
```

参数映射参考：

```json
{
  "prompt": "45.inputs.text",
  "width": "41.inputs.width",
  "height": "41.inputs.height",
  "batchSize": "41.inputs.batch_size",
  "steps": "44.inputs.steps",
  "cfg": "44.inputs.cfg",
  "sampler": "44.inputs.sampler_name",
  "scheduler": "44.inputs.scheduler",
  "seed": "44.inputs.seed",
  "shift": "47.inputs.shift"
}
```

`parameterKeys`、`allowedEnums`、`promptPolicy` 都会注入参数转化模板；Z-Image 默认不输出负向提示词。

