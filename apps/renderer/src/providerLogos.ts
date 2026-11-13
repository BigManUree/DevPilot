/**
 * 模型供应商官方图标（Simple Icons 官方 brand glyph，品牌色填充）：
 * deepseek #5786FE / openai 黑（官方单色）/ moonshot(Kimi) #1B1B1F / qwen #6950EF / zhipu(Z.ai) #2D2D2D
 * custom 为本地手绘滑杆图标。tile 用白底细边框（ccswitch 同款），glyph 彩色。
 */
import deepseek from './assets/providers/deepseek.svg';
import openai from './assets/providers/openai.svg';
import moonshot from './assets/providers/moonshot.svg';
import qwen from './assets/providers/qwen.svg';
import zhipu from './assets/providers/zhipu.svg';
import custom from './assets/providers/custom.svg';

export const PROVIDER_LOGOS: Record<string, string> = {
  deepseek,
  openai,
  moonshot,
  qwen,
  zhipu,
  custom,
};
