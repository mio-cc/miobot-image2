// Generated from the three user-approved ComfyUI API workflows.
import type { ComfyUiProfile } from './index.js';

export const COMFYUI_BUILTIN_REVISION = "2026-10-21";

export const BUILTIN_COMFYUI_PROFILES: ComfyUiProfile[] = [
  {
    "id": "moss-image-sft",
    "name": "MOSS-Image 社区增强 油纸伞少女",
    "workflow": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "moss_image_sft_int8_convrot.safetensors",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "MOSS-Image-SFT-4-steps.safetensors",
          "strength_model": 1
        }
      },
      "3": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "qwen3.5_9b_w4a8_gptq.safetensors",
          "type": "flux2"
        }
      },
      "4": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "flux2-vae_small.safetensors"
        }
      },
      "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "高质量的动漫插画：一位留着黑色长直发的少女撑着半透明的油纸伞，走在雨后的江南古巷里。她穿着改良白色汉服连衣裙，裙摆绣着淡青色云纹，眼神温柔中带着一丝忧伤。青石板路面湿漉漉地倒映着两旁挂着的红灯笼，雨水沿着白墙黛瓦滴落，空气中有薄薄的雾气。画面构图采用三分法，人物位于右侧三分之一处，远处巷子深处透出温暖的黄色灯光。色调以青灰和暖橙对比为主，细节精致，光影层次丰富，8K画质",
          "clip": [
            "3",
            0
          ]
        }
      },
      "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "马赛克, mosaic, censored, 模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符",
          "clip": [
            "3",
            0
          ]
        }
      },
      "7": {
        "class_type": "EmptyFlux2LatentImage",
        "inputs": {
          "width": 1280,
          "height": 720,
          "batch_size": 1
        }
      },
      "8": {
        "class_type": "KSamplerAdvanced",
        "inputs": {
          "model": [
            "2",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "6",
            0
          ],
          "latent_image": [
            "7",
            0
          ],
          "add_noise": "enable",
          "noise_seed": 0,
          "steps": 8,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "start_at_step": 0,
          "end_at_step": 10000,
          "return_with_leftover_noise": "disable"
        }
      },
      "9": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "8",
            0
          ],
          "vae": [
            "4",
            0
          ]
        }
      },
      "10": {
        "class_type": "UltralyticsDetectorProvider",
        "inputs": {
          "model_name": "bbox/face_yolov8m.pt"
        }
      },
      "11": {
        "class_type": "SAMLoader",
        "inputs": {
          "model_name": "sam_vit_b_01ec64.pth",
          "device_mode": "AUTO"
        }
      },
      "12": {
        "class_type": "FaceDetailer",
        "inputs": {
          "image": [
            "9",
            0
          ],
          "model": [
            "2",
            0
          ],
          "clip": [
            "3",
            0
          ],
          "vae": [
            "4",
            0
          ],
          "positive": [
            "13",
            0
          ],
          "negative": [
            "6",
            0
          ],
          "bbox_detector": [
            "10",
            0
          ],
          "sam_model_opt": [
            "11",
            0
          ],
          "guide_size": 384,
          "guide_size_for": true,
          "max_size": 2048,
          "seed": 0,
          "steps": 8,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 0.4,
          "feather": 11,
          "noise_mask": true,
          "force_inpaint": true,
          "bbox_threshold": 0.5,
          "bbox_dilation": 10,
          "bbox_crop_factor": 3,
          "sam_detection_hint": "center-1",
          "sam_dilation": 0,
          "sam_threshold": 0.93,
          "sam_bbox_expansion": 0,
          "sam_mask_hint_threshold": 0.7,
          "sam_mask_hint_use_negative": "False",
          "drop_size": 10,
          "wildcard": "",
          "cycle": 1,
          "inpaint_model": false,
          "noise_mask_feather": 20,
          "tiled_encode": false,
          "tiled_decode": false
        }
      },
      "13": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "高质量的动漫插画：一位留着黑色长直发的少女撑着半透明的油纸伞，走在雨后的江南古巷里。她穿着改良白色汉服连衣裙，裙摆绣着淡青色云纹，眼神温柔中带着一丝忧伤。青石板路面湿漉漉地倒映着两旁挂着的红灯笼，雨水沿着白墙黛瓦滴落，空气中有薄薄的雾气。画面构图采用三分法，人物位于右侧三分之一处，远处巷子深处透出温暖的黄色灯光。色调以青灰和暖橙对比为主，细节精致，光影层次丰富，8K画质,精致的脸部细节,明亮的眼睛,细致的手部",
          "clip": [
            "3",
            0
          ]
        }
      },
      "14": {
        "class_type": "UpscaleModelLoader",
        "inputs": {
          "model_name": "4x-AnimeSharp.safetensors"
        }
      },
      "15": {
        "class_type": "UltimateSDUpscale",
        "inputs": {
          "image": [
            "12",
            0
          ],
          "model": [
            "2",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "6",
            0
          ],
          "vae": [
            "4",
            0
          ],
          "upscale_model": [
            "14",
            0
          ],
          "upscale_by": 1.25,
          "seed": 0,
          "steps": 4,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 0.15,
          "mode_type": "Chess",
          "tile_width": 1024,
          "tile_height": 1024,
          "mask_blur": 8,
          "tile_padding": 32,
          "seam_fix_mode": "None",
          "seam_fix_denoise": 1,
          "seam_fix_width": 64,
          "seam_fix_mask_blur": 8,
          "seam_fix_padding": 16,
          "force_uniform_tiles": true,
          "tiled_decode": true,
          "batch_size": 1
        }
      },
      "16": {
        "class_type": "SaveImage",
        "inputs": {
          "images": [
            "15",
            0
          ],
          "filename_prefix": "moss_youxiang_usd"
        }
      }
    },
    "parameterMap": {
      "width": "7.inputs.width",
      "height": "7.inputs.height",
      "batchSize": "7.inputs.batch_size",
      "steps": "8.inputs.steps",
      "cfg": "8.inputs.cfg",
      "sampler": "8.inputs.sampler_name",
      "scheduler": "8.inputs.scheduler",
      "seed": "8.inputs.noise_seed",
      "loraStrength": "2.inputs.strength_model",
      "detailerSteps": "12.inputs.steps",
      "detailerCfg": "12.inputs.cfg",
      "detailerSampler": "12.inputs.sampler_name",
      "detailerScheduler": "12.inputs.scheduler",
      "detailerDenoise": "12.inputs.denoise",
      "detailerSeed": "12.inputs.seed",
      "guideSize": "12.inputs.guide_size",
      "upscaleBy": "15.inputs.upscale_by",
      "upscaleSteps": "15.inputs.steps",
      "upscaleCfg": "15.inputs.cfg",
      "upscaleSampler": "15.inputs.sampler_name",
      "upscaleScheduler": "15.inputs.scheduler",
      "upscaleDenoise": "15.inputs.denoise",
      "upscaleSeed": "15.inputs.seed"
    },
    "promptNodeIds": [
      "5",
      "13"
    ],
    "negativePromptNodeIds": [
      "6"
    ],
    "defaults": {
      "width": 1280,
      "height": 720,
      "batchSize": 1,
      "steps": 8,
      "cfg": 1,
      "sampler": "euler",
      "scheduler": "simple",
      "seed": 0,
      "loraStrength": 1,
      "detailerSteps": 8,
      "detailerCfg": 1,
      "detailerSampler": "euler",
      "detailerScheduler": "simple",
      "detailerDenoise": 0.4,
      "detailerSeed": 0,
      "guideSize": 384,
      "upscaleBy": 1.25,
      "upscaleSteps": 4,
      "upscaleCfg": 1,
      "upscaleSampler": "euler",
      "upscaleScheduler": "simple",
      "upscaleDenoise": 0.15,
      "upscaleSeed": 0,
      "negativePrompt": "马赛克, mosaic, censored, 模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符"
    },
    "constraints": {},
    "outputNodeId": "16",
    "stitch": {
      "enabled": false,
      "quality": 80,
      "columns": 0,
      "gap": 16,
      "label": false,
      "scale": 1,
      "maxWidth": 4096,
      "maxHeight": 4096,
      "background": "#111827"
    },
    "promptPolicy": {
      "modelFamily": "moss-image",
      "variant": "sft",
      "promptSyntax": "moss",
      "language": "zh",
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
      "defaultNegativePrompt": "马赛克, mosaic, censored, 模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符",
      "loraTriggers": []
    },
    "fallbackProfileId": "moss-image-sft",
    "fallbackEnabled": true,
    "builtinRevision": "2026-10-21",
    "customized": false
  },
  {
    "id": "krea-2-turbo",
    "name": "Krea 2 海报忠实版",
    "workflow": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "krea2_turbo_int8_convrot.safetensors",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "z3zz4-k2-4_krea2.safetensors",
          "strength_model": 0.85
        }
      },
      "3": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "2",
            0
          ],
          "lora_name": "m87_lora_v1_MGWR87.safetensors",
          "strength_model": 0.8
        }
      },
      "4": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "qwen3vl_4b_fp8_scaled.safetensors",
          "type": "krea2"
        }
      },
      "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "",
          "clip": [
            "4",
            0
          ]
        }
      },
      "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "马赛克, mosaic, censored, 模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符",
          "clip": [
            "4",
            0
          ]
        }
      },
      "7": {
        "class_type": "ConditioningZeroOut",
        "inputs": {
          "conditioning": [
            "5",
            0
          ]
        }
      },
      "8": {
        "class_type": "ModelSamplingAuraFlow",
        "inputs": {
          "model": [
            "20",
            0
          ],
          "shift": 3
        }
      },
      "9": {
        "class_type": "EmptySD3LatentImage",
        "inputs": {
          "width": 1920,
          "height": 1080,
          "batch_size": 1
        }
      },
      "10": {
        "class_type": "KSamplerAdvanced",
        "inputs": {
          "model": [
            "8",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "7",
            0
          ],
          "latent_image": [
            "9",
            0
          ],
          "add_noise": "enable",
          "noise_seed": 0,
          "steps": 10,
          "cfg": 1,
          "sampler_name": "er_sde",
          "scheduler": "simple",
          "start_at_step": 0,
          "end_at_step": 10000,
          "return_with_leftover_noise": "disable"
        }
      },
      "11": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "qwen_image_vae.safetensors"
        }
      },
      "12": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "10",
            0
          ],
          "vae": [
            "11",
            0
          ]
        }
      },
      "13": {
        "class_type": "UltralyticsDetectorProvider",
        "inputs": {
          "model_name": "bbox/face_yolov8m.pt"
        }
      },
      "14": {
        "class_type": "SAMLoader",
        "inputs": {
          "model_name": "sam_vit_b_01ec64.pth",
          "device_mode": "AUTO"
        }
      },
      "15": {
        "class_type": "FaceDetailer",
        "inputs": {
          "image": [
            "12",
            0
          ],
          "model": [
            "8",
            0
          ],
          "clip": [
            "4",
            0
          ],
          "vae": [
            "11",
            0
          ],
          "positive": [
            "16",
            0
          ],
          "negative": [
            "7",
            0
          ],
          "bbox_detector": [
            "13",
            0
          ],
          "sam_model_opt": [
            "14",
            0
          ],
          "guide_size": 389.333,
          "guide_size_for": true,
          "max_size": 2048,
          "seed": 0,
          "steps": 10,
          "cfg": 1,
          "sampler_name": "euler_ancestral",
          "scheduler": "normal",
          "denoise": 0.4,
          "feather": 11,
          "noise_mask": true,
          "force_inpaint": true,
          "bbox_threshold": 0.5,
          "bbox_dilation": 10,
          "bbox_crop_factor": 3,
          "sam_detection_hint": "center-1",
          "sam_dilation": 0,
          "sam_threshold": 0.93,
          "sam_bbox_expansion": 0,
          "sam_mask_hint_threshold": 0.7,
          "sam_mask_hint_use_negative": "False",
          "drop_size": 10,
          "wildcard": "",
          "cycle": 1,
          "inpaint_model": false,
          "noise_mask_feather": 20,
          "tiled_encode": false,
          "tiled_decode": false
        }
      },
      "16": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "masterpiece, best quality, ultra-detailed, highly aesthetic, sophisticated contemporary graphic design, cinematic editorial poster, premium literary art-book quality, refined two-dimensional illustration, experimental modernist poster design, expressive ink and gouache textures, restrained photographic realism, poetic urban atmosphere, literary visual storytelling, subtle early twentieth-century European aesthetic, visual language inspired exclusively by James Joyce's \"Ulysses\", translating stream of consciousness, urban wandering, fragmented observation, ordinary life, passing time, river movement, anonymous pedestrians, fleeting perception, interior thought, and the layered geography of a single city day into an original graphic composition, wide ultra-horizontal 21:9 composition, visually quiet but intellectually dense, carefully controlled negative space, strong asymmetrical balance, sophisticated editorial rhythm.\n\nCreate a highly designed flat poster rather than a conventional cinematic scene, combining illustrated urban realism with modernist graphic abstraction. Use a mixture of finely drawn architectural contours, simplified painted surfaces, selective photographic softness, muted ink textures, translucent color fields, controlled blur, sharp graphic edges, and carefully placed geometric interruptions. The image should feel printed and tactile, with subtle paper grain, delicate lithographic imperfections, faint ink absorption, and restrained analog texture. Preserve realistic environmental atmosphere while allowing portions of the city to become simplified graphic shapes. Use visual abstraction only where it strengthens composition, never turning the scene into an unreadable collage. No 3D rendering, no CGI, no glossy digital objects, no futuristic interface aesthetics.\n\nBuild the composition around a restrained palette of cold blue-gray, pale concrete, faded ivory, deep charcoal, muted green-gray, and dark desaturated navy. Introduce a very limited inverted accent system using small areas of near-black against pale ivory and occasional pale ivory shapes against deep charcoal. Add a single restrained muted ochre accent in one distant window or reflected street lamp. Use several clearly defined flat color blocks to interrupt the otherwise atmospheric illustration: a narrow charcoal rectangle near the edge of the composition, a pale ivory field partially covering architecture, and one muted blue-gray geometric plane crossing behind the character. These blocks should feel like intentional editorial interventions, creating visual rhythm and framing rather than decorative clutter.\n\nSet the scene in an early twentieth-century European city beside a broad river shortly after rainfall. The city should feel like an ordinary weekday morning or afternoon observed through the wandering consciousness of a solitary person. Construct a layered urban environment of narrow stone buildings, brick facades, tall windows, old shopfronts, iron balconies, wet streets, narrow sidewalks, bridge structures, tram cables, street lamps, distant pedestrians, bicycles, horse-drawn vehicles, and small riverside businesses. Keep the architecture believable but selectively simplified. Avoid creating a famous landmark or recognizable city. The environment should feel anonymous, dense with ordinary human activity, and filled with small visual observations.\n\nUse a significantly elevated camera position combined with a close wide-angle perspective. The viewpoint should feel as though the viewer is standing several stories above the riverside street while looking diagonally downward through the urban space. Bring the character and foreground railing relatively close to the viewer while allowing the river and architecture to recede dramatically into the distance. Use controlled wide-angle perspective to exaggerate the convergence of the railing, street, riverbank, and building facades without creating unnatural distortion. The wide lens should make the city feel spatially expansive while the elevated viewpoint compresses multiple layers of ordinary life into one visual field.\n\nPlace a solitary young adult woman near the center-right of the composition, standing beside a weathered riverside railing. She should be viewed from a slightly elevated three-quarter rear angle, with her body oriented toward the river and her head turned subtly toward the city. She has shoulder-length dark hair, pale natural skin, understated facial features, and a quiet introspective expression. Her presence should feel observational rather than dramatic, as though she has paused during an ordinary walk and become temporarily absorbed by the city around her. One hand rests lightly on the railing, while the other holds a closed dark umbrella after the rain.\n\nDress her in restrained early twentieth-century urban clothing: a long dark charcoal wool coat, high-neck ivory blouse, dark skirt reaching below the knees, dark stockings, modest leather shoes, and a narrow scarf. The clothing should contain realistic folds, dampened fabric around the lower edges, subtle water droplets, and muted material textures. Keep the silhouette elegant and simple. Avoid glamorous fashion styling, fantasy clothing, decorative accessories, or exaggerated character design. The figure should merge naturally into the historical environment while remaining the primary human focal point.\n\nMake the river the dominant spatial element beneath the character. It should extend through the composition as a broad dark horizontal and diagonal plane, reflecting fragments of architecture, bridge structures, pale sky, and distant lights. Because of the elevated camera, allow the viewer to see a significant portion of the river surface. Paint the reflections as elongated broken shapes rather than accurate mirror images. Some architectural reflections should become abstract vertical streaks, while others dissolve into soft horizontal ripples. The river should visually resemble fragmented thought, with individual reflections appearing and disappearing across its surface.\n\nCreate a strong foreground-to-background layering system. The foreground should contain the dark iron railing, wet pavement, a few puddles, and cropped architectural fragments. The character occupies the middle layer, partially intersecting the railing. The river and opposite bank form the secondary layer. The distant city should dissolve into pale atmospheric haze. Several nearby elements should be sharply illustrated while others become softly blurred, producing a controlled contrast between immediate perception and peripheral consciousness.\n\nUse selective blur as a graphic design device rather than a photographic defect. Keep the character, nearest railing, and several foreground architectural edges crisp. Allow distant pedestrians, passing vehicles, river reflections, and portions of the far architecture to become softly blurred through atmospheric perspective. Introduce one or two deliberate horizontal motion-blurred shapes suggesting a passing tram or carriage, partially cutting across the background. These blurred forms should create the sensation of a fleeting urban moment observed while walking through the city.\n\nIntroduce a restrained system of modernist lines throughout the composition. Use several thin charcoal and pale ivory lines following architectural perspective, river direction, and the edge of the railing. Allow one or two lines to extend beyond their expected architectural boundaries and continue across the image as abstract compositional guides. Include a few incomplete rectangular frames and one large subtle curved line echoing the river's trajectory. Keep these marks sparse and intentional, integrated with the illustration like remnants of an editorial layout or architectural drawing.\n\nUse controlled occlusion as a major compositional device. Allow a pale ivory graphic rectangle to partially cover a distant building facade. Let a dark charcoal shape obscure a small section of the riverbank. Allow one thin geometric line to disappear behind the character and reappear beyond her silhouette. Let portions of the title overlap the background architecture while remaining separated from the character. Use these interruptions to create depth and visual rhythm. Every occlusion should have a clear purpose and should never make the image difficult to understand.\n\nCreate one strong inverted-color section within the composition. A narrow vertical architectural area behind the character should shift into an almost negative-image treatment, with pale architectural contours appearing against a deep charcoal field. Keep this inversion limited to one region, as a graphic intervention rather than a global effect. The inverted section should visually anchor the character and create a moment of perceptual disruption, suggesting the unstable relationship between physical reality and inner consciousness in \"Ulysses\".\n\nUse several restrained geometric color fields to divide the composition. A pale ivory rectangular field may sit behind the main title in the upper-left area, partially covering the sky and distant architecture. A muted blue-gray block may intersect the lower edge of the composition and overlap a fragment of the river. A narrow charcoal strip may align with the railing and extend toward the character. Keep all color fields flat, matte, and slightly textured like printed paper. They should create visual hierarchy without turning the poster into a purely abstract design.\n\nTypography should be extremely limited and carefully integrated into the composition. Place one large primary title in the upper-left quadrant: \"ULYSSES\". Use a refined high-contrast serif typeface inspired by early twentieth-century literary publishing, with narrow proportions, elegant contrast, and generous tracking. The title should be large enough to establish the poster identity but should remain secondary to the character and river. Place a very small supporting line beneath it reading \"ONE DAY / ONE CITY\". Keep the typography flat, printed, and slightly textured. No additional paragraphs, metadata, technical labels, coordinates, barcodes, or decorative microtext.\n\nAllow the title to interact with the graphic composition. Part of \"ULYSSES\" may sit over a pale ivory color field while the final letters extend slightly into the surrounding architectural image. One thin line may pass behind the typography and continue toward the river. The smaller phrase \"ONE DAY / ONE CITY\" should align precisely with the lower edge of the main title. Typography should function as a visual anchor and compositional counterweight rather than an independent information layer.\n\nUse a subtle sequence of repeated urban motifs to evoke the stream of consciousness: identical windows appearing at different distances, repeated vertical railings, recurring street lamps, reflections of the same architectural shapes in different sections of the river, and several similar figures moving along different streets. These repetitions should remain natural and understated, suggesting the sensation of noticing the same forms repeatedly during a long urban walk.\n\nInclude only a few human figures in the background. They should be small, anonymous, and partially obscured by architecture or atmospheric haze. Some may carry umbrellas, some may walk along the river, and one may stand beneath a street lamp. Their individual identities should remain indistinct. The purpose is to suggest a continuous flow of ordinary urban life surrounding the solitary central figure.\n\nThe post-rain lighting should remain soft and subdued. Use pale overcast daylight as the primary illumination, creating cool diffuse shadows and muted reflections. Add only tiny warm highlights from distant windows and lamps. Wet surfaces should absorb and scatter the light softly. The atmosphere should contain faint river mist and humid haze, with distant architecture losing contrast gradually. Avoid dramatic sunlight, heavy fog, exaggerated bloom, neon, or theatrical lighting.\n\nThe composition should have a clear visual progression: the large \"ULYSSES\" title and pale graphic field establish the upper-left anchor, the diagonal railing guides the eye downward toward the solitary woman, the woman directs attention toward the river and distant city, and the river carries the composition horizontally toward the far edge. The inverted architectural block provides a visual interruption near the character, while thin graphic lines connect the major areas. The eye should move continuously through the poster without encountering clutter.\n\nKeep generous negative space in the upper region around the title and pale sky. Allow several architectural forms to be cropped aggressively at the edges, creating the sensation that the city continues beyond the poster. Keep the lower region more materially dense with river reflections, railing, pavement, and architectural fragments. Maintain a strong balance between empty atmospheric space and concentrated urban detail.\n\nThe final image should feel like a single fragment of an ordinary city day transformed by consciousness: a person pauses beside the river, buildings repeat themselves through wet reflections, distant figures pass without significance, architecture becomes geometry, motion dissolves into blur, and fragments of the physical city seem to overlap with fragments of thought. The design should express the essential visual qualities of \"Ulysses\" through urban wandering, stream of consciousness, fragmented perception, temporal layering, ordinary human existence, and the relationship between a person and the city they move through. Keep the result sophisticated, literary, restrained, atmospheric, experimental, and highly graphic, with the illustration, color blocks, inverted section, occlusion, blur, typography, lines, and wide-angle perspective working together as one coherent poster system., detailed hands, nails",
          "clip": [
            "4",
            0
          ]
        }
      },
      "17": {
        "class_type": "UpscaleModelLoader",
        "inputs": {
          "model_name": "4x-AnimeSharp.safetensors"
        }
      },
      "18": {
        "class_type": "UltimateSDUpscale",
        "inputs": {
          "image": [
            "15",
            0
          ],
          "model": [
            "8",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "7",
            0
          ],
          "vae": [
            "11",
            0
          ],
          "upscale_model": [
            "17",
            0
          ],
          "upscale_by": 1.5,
          "seed": 0,
          "steps": 4,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 0.15,
          "mode_type": "Chess",
          "tile_width": 1024,
          "tile_height": 1024,
          "mask_blur": 8,
          "tile_padding": 32,
          "seam_fix_mode": "None",
          "force_uniform_tiles": true,
          "tiled_decode": true,
          "batch_size": 1,
          "seam_fix_width": 64,
          "seam_fix_denoise": 1,
          "seam_fix_padding": 16,
          "seam_fix_mask_blur": 8
        }
      },
      "19": {
        "class_type": "SaveImage",
        "inputs": {
          "images": [
            "18",
            0
          ],
          "filename_prefix": "krea2_faithful_2880"
        }
      },
      "20": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "3",
            0
          ],
          "lora_name": "Detailer-KREA2-detailslider.safetensors",
          "strength_model": 1
        }
      }
    },
    "parameterMap": {
      "width": "9.inputs.width",
      "height": "9.inputs.height",
      "batchSize": "9.inputs.batch_size",
      "steps": "10.inputs.steps",
      "cfg": "10.inputs.cfg",
      "sampler": "10.inputs.sampler_name",
      "scheduler": "10.inputs.scheduler",
      "seed": "10.inputs.noise_seed",
      "shift": "8.inputs.shift",
      "loraBaseStrength": "2.inputs.strength_model",
      "loraStyleStrength": "3.inputs.strength_model",
      "loraDetailStrength": "20.inputs.strength_model",
      "detailerSteps": "15.inputs.steps",
      "detailerCfg": "15.inputs.cfg",
      "detailerSampler": "15.inputs.sampler_name",
      "detailerScheduler": "15.inputs.scheduler",
      "detailerDenoise": "15.inputs.denoise",
      "detailerSeed": "15.inputs.seed",
      "guideSize": "15.inputs.guide_size",
      "upscaleBy": "18.inputs.upscale_by",
      "upscaleSteps": "18.inputs.steps",
      "upscaleCfg": "18.inputs.cfg",
      "upscaleSampler": "18.inputs.sampler_name",
      "upscaleScheduler": "18.inputs.scheduler",
      "upscaleDenoise": "18.inputs.denoise",
      "upscaleSeed": "18.inputs.seed"
    },
    "promptNodeIds": [
      "5",
      "16"
    ],
    "negativePromptNodeIds": [
      "6"
    ],
    "defaults": {
      "width": 1920,
      "height": 1080,
      "batchSize": 1,
      "steps": 10,
      "cfg": 1,
      "sampler": "er_sde",
      "scheduler": "simple",
      "seed": 0,
      "shift": 3,
      "loraBaseStrength": 0.85,
      "loraStyleStrength": 0.8,
      "loraDetailStrength": 1,
      "detailerSteps": 10,
      "detailerCfg": 1,
      "detailerSampler": "euler_ancestral",
      "detailerScheduler": "normal",
      "detailerDenoise": 0.4,
      "detailerSeed": 0,
      "guideSize": 389.333,
      "upscaleBy": 1.5,
      "upscaleSteps": 4,
      "upscaleCfg": 1,
      "upscaleSampler": "euler",
      "upscaleScheduler": "simple",
      "upscaleDenoise": 0.15,
      "upscaleSeed": 0
    },
    "constraints": {},
    "outputNodeId": "19",
    "stitch": {
      "enabled": false,
      "quality": 80,
      "columns": 0,
      "gap": 16,
      "label": false,
      "scale": 1,
      "maxWidth": 4096,
      "maxHeight": 4096,
      "background": "#111827"
    },
    "promptPolicy": {
      "modelFamily": "krea-2",
      "variant": "turbo",
      "promptSyntax": "krea",
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
      "defaultNegativePrompt": "",
      "loraTriggers": []
    },
    "fallbackProfileId": "krea-2-turbo",
    "fallbackEnabled": true,
    "builtinRevision": "2026-10-21",
    "customized": false
  },
  {
    "id": "z-image-turbo",
    "name": "Z-Image 社区增强 油纸伞少女",
    "workflow": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "z_image_turbo_bf16.safetensors",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "qwen_3_4b.safetensors",
          "type": "lumina2"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "ae.safetensors"
        }
      },
      "4": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "masterpiece, best quality, ultra-detailed anime illustration, a graceful girl with long black hair and amber eyes holding a translucent oil-paper umbrella, walking through an ancient rain-soaked alley after the rain, wet bluestone road reflecting warm lantern light, water droplets suspended in air, her white hanfu-inspired dress with subtle embroidery, gentle melancholy expression, glowing puddle reflections, soft volumetric mist, cinematic composition with leading lines, rich color grading, 8k wallpaper quality",
          "clip": [
            "2",
            0
          ]
        }
      },
      "5": {
        "class_type": "ConditioningZeroOut",
        "inputs": {
          "conditioning": [
            "4",
            0
          ]
        }
      },
      "6": {
        "class_type": "ModelSamplingAuraFlow",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "shift": 3
        }
      },
      "7": {
        "class_type": "EmptySD3LatentImage",
        "inputs": {
          "width": 1280,
          "height": 720,
          "batch_size": 1
        }
      },
      "8": {
        "class_type": "KSampler",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "positive": [
            "4",
            0
          ],
          "negative": [
            "5",
            0
          ],
          "latent_image": [
            "7",
            0
          ],
          "seed": 0,
          "steps": 9,
          "cfg": 1,
          "sampler_name": "res_multistep",
          "scheduler": "simple",
          "denoise": 1
        }
      },
      "9": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "8",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "10": {
        "class_type": "UltralyticsDetectorProvider",
        "inputs": {
          "model_name": "bbox/face_yolov9c.pt"
        }
      },
      "11": {
        "class_type": "SAMLoader",
        "inputs": {
          "model_name": "sam_vit_b_01ec64.pth",
          "device_mode": "AUTO"
        }
      },
      "12": {
        "class_type": "FaceDetailer",
        "inputs": {
          "image": [
            "9",
            0
          ],
          "model": [
            "6",
            0
          ],
          "clip": [
            "2",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "positive": [
            "13",
            0
          ],
          "negative": [
            "5",
            0
          ],
          "bbox_detector": [
            "10",
            0
          ],
          "sam_model_opt": [
            "11",
            0
          ],
          "guide_size": 384,
          "guide_size_for": true,
          "max_size": 2048,
          "seed": 0,
          "steps": 8,
          "cfg": 1,
          "sampler_name": "res_multistep",
          "scheduler": "simple",
          "denoise": 0.4,
          "feather": 11,
          "noise_mask": true,
          "force_inpaint": true,
          "bbox_threshold": 0.5,
          "bbox_dilation": 10,
          "bbox_crop_factor": 3,
          "sam_detection_hint": "center-1",
          "sam_dilation": 0,
          "sam_threshold": 0.93,
          "sam_bbox_expansion": 0,
          "sam_mask_hint_threshold": 0.7,
          "sam_mask_hint_use_negative": "False",
          "drop_size": 10,
          "wildcard": "",
          "cycle": 1,
          "inpaint_model": false,
          "noise_mask_feather": 20,
          "tiled_encode": false,
          "tiled_decode": false
        }
      },
      "13": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "masterpiece, best quality, ultra-detailed anime illustration, a graceful girl with long black hair and amber eyes holding a translucent oil-paper umbrella, walking through an ancient rain-soaked alley after the rain, wet bluestone road reflecting warm lantern light, water droplets suspended in air, her white hanfu-inspired dress with subtle embroidery, gentle melancholy expression, glowing puddle reflections, soft volumetric mist, cinematic composition with leading lines, rich color grading, 8k wallpaper quality, detailed face, detailed eyes, detailed hands",
          "clip": [
            "2",
            0
          ]
        }
      },
      "14": {
        "class_type": "UpscaleModelLoader",
        "inputs": {
          "model_name": "4x_foolhardy_Remacri.pth"
        }
      },
      "15": {
        "class_type": "UltimateSDUpscale",
        "inputs": {
          "image": [
            "12",
            0
          ],
          "model": [
            "6",
            0
          ],
          "positive": [
            "4",
            0
          ],
          "negative": [
            "5",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "upscale_model": [
            "14",
            0
          ],
          "upscale_by": 1.5,
          "seed": 0,
          "steps": 4,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 0.15,
          "mode_type": "Chess",
          "tile_width": 1024,
          "tile_height": 1024,
          "mask_blur": 8,
          "tile_padding": 32,
          "seam_fix_mode": "None",
          "seam_fix_denoise": 1,
          "seam_fix_width": 64,
          "seam_fix_mask_blur": 8,
          "seam_fix_padding": 16,
          "force_uniform_tiles": true,
          "tiled_decode": true,
          "batch_size": 1
        }
      },
      "16": {
        "class_type": "SaveImage",
        "inputs": {
          "images": [
            "15",
            0
          ],
          "filename_prefix": "zimage_youxiang_usd"
        }
      }
    },
    "parameterMap": {
      "width": "7.inputs.width",
      "height": "7.inputs.height",
      "batchSize": "7.inputs.batch_size",
      "steps": "8.inputs.steps",
      "cfg": "8.inputs.cfg",
      "sampler": "8.inputs.sampler_name",
      "scheduler": "8.inputs.scheduler",
      "seed": "8.inputs.seed",
      "shift": "6.inputs.shift",
      "detailerSteps": "12.inputs.steps",
      "detailerCfg": "12.inputs.cfg",
      "detailerSampler": "12.inputs.sampler_name",
      "detailerScheduler": "12.inputs.scheduler",
      "detailerDenoise": "12.inputs.denoise",
      "detailerSeed": "12.inputs.seed",
      "guideSize": "12.inputs.guide_size",
      "upscaleBy": "15.inputs.upscale_by",
      "upscaleSteps": "15.inputs.steps",
      "upscaleCfg": "15.inputs.cfg",
      "upscaleSampler": "15.inputs.sampler_name",
      "upscaleScheduler": "15.inputs.scheduler",
      "upscaleDenoise": "15.inputs.denoise",
      "upscaleSeed": "15.inputs.seed"
    },
    "promptNodeIds": [
      "4",
      "13"
    ],
    "negativePromptNodeIds": [],
    "defaults": {
      "width": 1280,
      "height": 720,
      "batchSize": 1,
      "steps": 9,
      "cfg": 1,
      "sampler": "res_multistep",
      "scheduler": "simple",
      "seed": 0,
      "shift": 3,
      "detailerSteps": 8,
      "detailerCfg": 1,
      "detailerSampler": "res_multistep",
      "detailerScheduler": "simple",
      "detailerDenoise": 0.4,
      "detailerSeed": 0,
      "guideSize": 384,
      "upscaleBy": 1.5,
      "upscaleSteps": 4,
      "upscaleCfg": 1,
      "upscaleSampler": "euler",
      "upscaleScheduler": "simple",
      "upscaleDenoise": 0.15,
      "upscaleSeed": 0
    },
    "constraints": {},
    "outputNodeId": "16",
    "stitch": {
      "enabled": false,
      "quality": 80,
      "columns": 0,
      "gap": 16,
      "label": false,
      "scale": 1,
      "maxWidth": 4096,
      "maxHeight": 4096,
      "background": "#111827"
    },
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
      "maxPromptChars": 4000,
      "maxWeights": 0,
      "weightMin": 1,
      "weightMax": 1,
      "defaultNegativePrompt": "",
      "loraTriggers": []
    },
    "fallbackProfileId": "z-image-turbo",
    "fallbackEnabled": true,
    "builtinRevision": "2026-10-21",
    "customized": false
  }
];

export function builtinComfyUiProfile(id: string): ComfyUiProfile | undefined {
  const item = BUILTIN_COMFYUI_PROFILES.find((profile) => profile.id === String(id || ''));
  return item ? JSON.parse(JSON.stringify(item)) as ComfyUiProfile : undefined;
}

export function builtinComfyUiProfileIds(): string[] {
  return BUILTIN_COMFYUI_PROFILES.map((profile) => profile.id);
}
