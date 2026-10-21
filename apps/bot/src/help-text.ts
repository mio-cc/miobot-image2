import type { AppConfig } from '../../../packages/config/src/index.js';
import { FEATURE_DEFINITIONS, type FeatureSetting } from '../../../packages/shared/src/features.js';

export function buildHelpText(cfg: AppConfig): string {
  const settings = (cfg.bot.features || {}) as Record<string, FeatureSetting>;
  const lines: string[] = ['Miobot 指令与帮助：'];
  const add = (id: string, suffix = '') => {
    const def = FEATURE_DEFINITIONS.find((item) => item.id === id);
    const setting = settings[id];
    if (!def?.implemented || !setting?.enabled || !setting.aliases.length) return;
    lines.push('- ' + def.label + ': ' + setting.aliases[0] + suffix);
  };
  add('image.generate', ' <描述>');
  add('image.img2img', ' <描述>（带图）');
  add('image.edit', ' <描述>（带图）');
  add('image.interrogate', '（带图）');
  add('template.library');
  add('template.referenced');
  add('template.remoteSearch');
  add('template.remoteSmartImage');
  add('file.list');
  add('file.read');
  add('file.generate');
  add('search.web');
  add('code.render');
  add('web.screenshot');
  add('help');
  add('clear');

  lines.push('', '【对话与搜索】');
  lines.push('- 私聊直接说话；群聊 @机器人 或回复机器人消息。');
  lines.push('- 天气、新闻、价格、赛事、最新版本等实时信息会自动联网搜索。');
  lines.push('- 身份、解释、写作、代码问答等普通问题直接聊天回复。');
  lines.push('- 长期记忆按 群聊 / 私聊 / 用户个人 隔离；不会把不同 QQ 当成同一个人。');
  lines.push('- /新对话 或 /clear 清空当前会话上下文。');

  lines.push('', '【生图与视频】');
  lines.push('- 明确说：画一只猫 / 生成一张赛博朋克海报，横图。');
  lines.push('- 改图时引用图片并说明要改什么。');
  lines.push('- 不需要填写 steps、CFG、sampler、batch_size；这些由后台 ComfyUI 工作流决定。');
  lines.push('- 支持 MOSS-Image、Krea2、Z-Image 等工作流；工作流参数可在后台面板调整。');
  if (settings['video.generate']?.enabled) {
    lines.push('- 视频：明确说生成视频 / 做个视频，或使用 video!、6s!、720p! 等参数。');
  }

  lines.push('', '【语音与 FishAudio】');
  lines.push('- 可以说：换成温柔女声 / 搜索讲故事音色 / 试听第二个 / 就用这个音色。');
  lines.push('- 自动 TTS 只在后台开启后生效；帮助和命令结果不会自动转语音。');
  lines.push('- 语音发送结果不确定时不会补发同内容文本，避免双回复。');

  if (cfg.orchestration?.suno?.enabled) {
    lines.push('', '【Suno 音乐】');
    lines.push('- 可以说：来一首雨夜日语女声歌曲 / 做一首 90 秒悬疑纯音乐。');
    lines.push('- 普通点歌由 Suno 自动生成歌词；明确要求完整歌词时才进入 Custom Mode。');
    lines.push('- 可指定歌名、语言、纯音乐、时长、排除项、人声性别和风格。');
  }

  lines.push('', '【文件、代码画图和网页截图】');
  lines.push('- 支持 md、docx、xlsx、pptx、pdf、txt、csv、json、zip。');
  lines.push('- 可说：把刚才内容导出成 docx / 读取我发的表格 / 列一下当前文件。');
  lines.push('- 代码画图：用 HTML/SVG/Canvas/Three.js 画一个……');
  lines.push('- 网页截图：截一下 https://example.com 或 网页截图 https://example.com 1200x800');

  lines.push('', '【画布图库】');
  lines.push('- 可查看、同步和发送画布生成的图片；画布权限由后台控制。');

  lines.push('', '【权限与审批】');
  lines.push('- 低风险操作默认允许；中高风险按后台 allow / ask_admin / deny 策略执行。');
  lines.push('- 需要审批时会私聊管理员，超时默认拒绝或取消，不会自动放行。');
  lines.push('- 普通用户不会看到内部异常；异常统一上报管理员。');

  lines.push('', '【主人命令】');
  lines.push('- /模型 或 /模型列表：查看模型列表。');
  lines.push('- /切换 <模型>：切换文本模型。');
  lines.push('- ch：撤回当前聊天最近 1 条机器人消息；plch [n]：撤回最近 n 条。');

  lines.push('', '【回复策略】');
  lines.push('- 纯文本可配置为文本转图片；失败自动回退文本。');
  lines.push('- 图片、文件、语音、合并转发统一走 ReplyPlan；同内容不会同时发文本和语音。');
  const extra = String(cfg.orchestration?.help?.extraText || '').trim();
  if (extra) lines.push('', '【自定义说明】', extra);
  return lines.join('\n');
}
