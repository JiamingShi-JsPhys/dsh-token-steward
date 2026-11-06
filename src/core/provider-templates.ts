/**
 * 厂商与全量模型目录（Token 管家的静态模板数据）。
 *
 * 数据来源：产品设计给定的六维评分表，**逐字录入，不做任何再计算**——
 * 总分、Tier、每一维的数值与字母评级之间不是可推导关系（例：73.2 是 SSS
 * 而 75.0 是 SS），因此它们是彼此独立的事实字段，改一个字都是错的。
 *
 * 两个不在评分表里的字段：
 *  - `contextWindow`：表里没有窗口数据，统一按保守的 128k 兜底；
 *    已知确切窗口的厂商可在 vendors.json 的厂商配置里覆盖。
 *  - `costPer1kInput/Output`：表里没有价格，一律 null =「未定价」，
 *    面板显示 —，绝不冒充 ¥0。
 *
 * 能力标签只给有公开事实依据的：coding / reasoning 全员基线；
 * vision 只给长期出货多模态的三家（Anthropic / OpenAI / Google）。
 */
import type { DimensionScore, DimensionKey, DimensionSet, ModelInfo } from './types.ts'

/** 一个目录模型（评分表的一行）。 */
export interface TemplateModel {
  id: string
  name: string
  tier: string
  contextWindow: number
  costPer1kInput: number | null
  costPer1kOutput: number | null
  capabilities: string[]
  scores: DimensionSet
  /** 擅长什么（一句话）。 */
  strengths?: string
  /** 擅长标签（机器可读）。 */
  strengthTags?: string[]
  imageInput?: boolean
  imageOutput?: boolean
  videoOutput?: boolean
}

/** 一家厂商（评分表的一节）。 */
export interface TemplateVendor {
  vendorId: string
  vendorName: string
  /** 官方 API Base URL；开源托管/占位的厂商为空串，必须由用户填 customUrl。 */
  officialUrl: string
  models: TemplateModel[]
}

function dim(score: number, grade: string): DimensionScore {
  return { score, grade }
}

function dims(reasoning: DimensionScore, longContext: DimensionScore, coding: DimensionScore, agentic: DimensionScore, proWork: DimensionScore, factuality: DimensionScore): DimensionSet {
  return { reasoning, longContext, coding, agentic, proWork, factuality }
}

/** 评分表没有的维度不存在——六个键一个不能少。 */
/** 未评分厂商的中性六维：不编造数值，路由按 50 处理，评级显示 NA。 */
function neutralScores(): DimensionSet {
  return {
    reasoning: dim(50, 'NA'),
    longContext: dim(50, 'NA'),
    coding: dim(50, 'NA'),
    agentic: dim(50, 'NA'),
    proWork: dim(50, 'NA'),
    factuality: dim(50, 'NA'),
  }
}

export const DIMENSION_KEYS: readonly DimensionKey[] = ['reasoning', 'longContext', 'coding', 'agentic', 'proWork', 'factuality']

export const PROVIDER_TEMPLATES: readonly TemplateVendor[] = [
  {
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    officialUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'SSS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(79.3, 'SSS'), dim(56.2, 'SS'), dim(80.7, 'SSS'), dim(85.4, 'SSS'), dim(64.7, 'SSS'), dim(73.2, 'SSS')), strengthTags: ['编程', '智能体', '推理'] },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(78.4, 'SSS'), dim(50.4, 'A+'), dim(77.1, 'SS'), dim(85.2, 'SSS'), dim(64.0, 'SSS'), dim(71.7, 'SSS')), strengthTags: ['编程', '智能体'] },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(77.8, 'SSS'), dim(62.2, 'SSS'), dim(81.1, 'SSS'), dim(81.2, 'SS'), dim(58.4, 'S'), dim(66.2, 'SS')), strengthTags: ['编程'] },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tier: 'A+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(67.2, 'A+'), dim(58.8, 'SS'), dim(66.6, 'A+'), dim(61.6, 'B+'), dim(51.3, 'B+'), dim(55.3, 'A')), strengthTags: ['快速', '做题'] },
    ],
  },
  {
    vendorId: 'openai',
    vendorName: 'OpenAI',
    officialUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(77.8, 'SSS'), dim(61.2, 'SSS'), dim(77.9, 'SS'), dim(84.0, 'SSS'), dim(55.2, 'A+'), dim(71.7, 'SSS')), strengthTags: ['编程', '推理', '智能体'] },
      { id: 'gpt-6-1-sol', name: 'GPT-6.1 Sol', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(77.5, 'SSS'), dim(60.7, 'SSS'), dim(76.4, 'SS'), dim(80.4, 'SS'), dim(55.5, 'A+'), dim(70.8, 'SS')), strengthTags: ['编程'] },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision'], scores: dims(dim(58.4, 'B+'), dim(54.7, 'S'), dim(58.1, 'B+'), dim(56.8, 'B'), dim(48.2, 'B'), dim(50.3, 'B')), strengthTags: ['文案'] },
    ],
  },
  {
    vendorId: 'google',
    vendorName: 'Google',
    officialUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(78.5, 'SSS'), dim(46.8, 'A'), dim(75.1, 'SS'), dim(80.1, 'SS'), dim(62.7, 'SS'), dim(71.2, 'SSS')), strengthTags: ['推理', '多模态'] },
      { id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision'], scores: dims(dim(58.0, 'B+'), dim(45.9, 'B+'), dim(56.9, 'B'), dim(52.6, 'G+'), dim(47.3, 'B'), dim(64.8, 'S')), strengthTags: ['多模态', '快速'] },
      { id: 'gemini-3-5-flash-lite', name: 'Gemini 3.5 Flash-Lite', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision'], scores: dims(dim(29.1, 'D'), dim(43.3, 'B'), dim(31.5, 'D'), dim(12.2, 'D'), dim(33.5, 'D'), dim(52.6, 'B+')), strengthTags: ['快速'] },
    ],
  },
  {
    vendorId: 'meta',
    vendorName: 'Meta (开源托管)',
    officialUrl: '',
    models: [
      { id: 'muse-wonder-full', name: 'Muse Wonder Full', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(76.1, 'SS'), dim(55.5, 'S'), dim(74.2, 'SS'), dim(79.4, 'SS'), dim(63.1, 'SSS'), dim(65.1, 'S')), strengthTags: ['做题', '智能体'] },
      { id: 'muse-wonder', name: 'Muse Wonder', tier: 'S', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(71.2, 'S'), dim(53.0, 'S'), dim(71.0, 'S'), dim(66.1, 'A'), dim(61.6, 'SS'), dim(62.7, 'S')), strengthTags: ['做题'] },
      { id: 'muse-spark-1-3', name: 'Muse Spark 1.3', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(61.4, 'A'), dim(48.4, 'A'), dim(64.1, 'A'), dim(61.3, 'B+'), dim(58.1, 'S'), dim(62.5, 'S')), strengthTags: ['做题'] },
      { id: 'muse-spark-open', name: 'Muse Spark Open', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(50.7, 'C+'), dim(47.8, 'A'), dim(49.7, 'C+'), dim(41.5, 'D'), dim(47.2, 'B'), dim(62.3, 'S')), strengthTags: ['做题'] },
      { id: 'muse-glimmer', name: 'Muse Glimmer', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(28.9, 'D'), dim(44.0, 'B+'), dim(26.0, 'D'), dim(7.8, 'D'), dim(31.7, 'D'), dim(33.6, 'D')), strengthTags: ['小模型'] },
    ],
  },
  {
    vendorId: 'deepseek',
    vendorName: 'DeepSeek',
    officialUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-v4-1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', tier: 'A+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(62.4, 'A'), dim(51.8, 'A+'), dim(69.4, 'S'), dim(68.6, 'A+'), dim(60.1, 'SS'), dim(52.4, 'B+')), strengthTags: ['编程', '智能体'] },
      { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(53.9, 'B'), dim(48.0, 'A'), dim(57.2, 'B+'), dim(41.1, 'D'), dim(49.7, 'B+'), dim(50.4, 'B')), strengthTags: ['推理'] },
    ],
  },
  {
    // 火山方舟（豆包）。注意：方舟上每个模型常以「推理接入点」id 暴露，
    // 面板里的「测试连接并拉取模型」会列出账号可用的真实 id，勾选即可。
    vendorId: 'doubao',
    vendorName: '豆包 Doubao',
    officialUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { id: 'doubao-seed-1-6', name: 'Doubao Seed 1.6', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: neutralScores(), strengthTags: ['智能体', '多模态'], imageInput: true },
      { id: 'doubao-seed-1-6-flash', name: 'Doubao Seed 1.6 Flash', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'fast', 'vision'], scores: neutralScores(), strengthTags: ['快速', '多模态'], imageInput: true },
      { id: 'doubao-1-5-pro-32k', name: 'Doubao 1.5 Pro 32K', tier: 'NA', contextWindow: 32_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: neutralScores(), strengthTags: ['文案'] },
      { id: 'doubao-1-5-lite-32k', name: 'Doubao 1.5 Lite 32K', tier: 'NA', contextWindow: 32_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['fast'], scores: neutralScores(), strengthTags: ['快速'] },
    ],
  },
  {
    // Agnes（模型清单来自本机真实 /models 探测，见 vendors.spec 同源验证）。
    vendorId: 'agnes',
    vendorName: 'Agnes',
    officialUrl: 'https://api.agnes-ai.cn/v1',
    models: [
      { id: 'agnes-3-0-flash', name: 'Agnes 3.0 Flash', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['fast', 'coding', 'tool-use'], scores: neutralScores(), strengthTags: ['快速', '编程'] },
      { id: 'agnes-2-5-pro', name: 'Agnes 2.5 Pro', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['推理'] },
      { id: 'agnes-2-5-pro-alpha', name: 'Agnes 2.5 Pro Alpha', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['推理'] },
      { id: 'agnes-2-5-pro-beta', name: 'Agnes 2.5 Pro Beta', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['推理'] },
      { id: 'agnes-2-5-flash', name: 'Agnes 2.5 Flash', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['fast', 'coding', 'tool-use'], scores: neutralScores(), strengthTags: ['快速'] },
      { id: 'agnes-image-2-5-flash', name: 'Agnes Image 2.5 Flash', tier: 'NA', contextWindow: 8_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['image_gen'], scores: neutralScores(), strengthTags: ['图像生成'], imageOutput: true },
      { id: 'agnes-image-2-1-flash', name: 'Agnes Image 2.1 Flash', tier: 'NA', contextWindow: 8_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['image_gen'], scores: neutralScores(), strengthTags: ['图像生成'], imageOutput: true },
      { id: 'agnes-video-2-5', name: 'Agnes Video 2.5', tier: 'NA', contextWindow: 8_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['video_gen'], scores: neutralScores(), strengthTags: ['视频'], videoOutput: true },
      { id: 'agnes-video-2-5-flash', name: 'Agnes Video 2.5 Flash', tier: 'NA', contextWindow: 8_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['video_gen'], scores: neutralScores(), strengthTags: ['视频'], videoOutput: true },
    ],
  },
  {
    vendorId: 'inkling',
    vendorName: 'Inkling',
    officialUrl: '',
    models: [
      { id: 'inkling', name: 'Inkling', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['reasoning'], scores: neutralScores(), strengthTags: ['做题'] },
      { id: 'inkling-small', name: 'Inkling Small', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['reasoning'], scores: neutralScores(), strengthTags: ['小模型'] },
    ],
  },
  {
    vendorId: 'moonshot',
    vendorName: 'Moonshot AI',
    officialUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k3-1-pro', name: 'Kimi K3.1 Pro', tier: 'S', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(73.2, 'SS'), dim(56.6, 'SS'), dim(75.0, 'SS'), dim(70.5, 'A+'), dim(57.0, 'A+'), dim(64.8, 'S')), strengthTags: ['做题', '推理'] },
    ],
  },
  {
    vendorId: 'alibaba',
    vendorName: 'Alibaba Qwen',
    officialUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3-8-max-0902', name: 'Qwen3.8 Max 0902', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(60.5, 'A'), dim(50.2, 'A+'), dim(63.8, 'A'), dim(58.4, 'B'), dim(56.1, 'A+'), dim(56.0, 'A')), strengthTags: ['文案'] },
      { id: 'qwen3-8-flash-next', name: 'Qwen3.8-Flash-Next', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(53.1, 'B'), dim(48.5, 'A+'), dim(52.6, 'B'), dim(36.7, 'C'), dim(53.7, 'A'), dim(55.1, 'C+')), strengthTags: ['快速', '中文'] },
      { id: 'qwen3-8-27b', name: 'Qwen3.8 27B', tier: 'C+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(40.4, 'C'), dim(52.4, 'A+'), dim(49.8, 'C+'), dim(34.0, 'D'), dim(51.7, 'B+'), dim(45.0, 'C+')), strengthTags: ['小模型'] },
    ],
  },
  {
    vendorId: 'xiaomi',
    vendorName: 'Xiaomi',
    officialUrl: '',
    models: [
      { id: 'mimo-v2-6-pro', name: 'MiMo-V2.6-Pro', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(62.7, 'A'), dim(49.6, 'A'), dim(63.7, 'A'), dim(66.2, 'A'), dim(56.4, 'A+'), dim(54.2, 'B+')), strengthTags: ['推理'] },
      { id: 'mimo-v2-6-flash', name: 'MiMo-V2.6-Flash', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(56.2, 'B+'), dim(43.0, 'B'), dim(57.2, 'B+'), dim(49.5, 'C+'), dim(53.5, 'A'), dim(43.7, 'C+')), strengthTags: ['便宜', '批量'] },
    ],
  },
  {
    vendorId: 'zhipu',
    vendorName: 'Z.ai / 智谱',
    officialUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5-3', name: 'GLM-5.3', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(56.1, 'B+'), dim(48.4, 'A'), dim(64.3, 'A'), dim(39.8, 'D'), dim(57.2, 'S'), dim(57.1, 'A')), strengthTags: ['文案', '中文'] },
      { id: 'glm-5-3-flash', name: 'GLM-5.3-Flash', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(43.7, 'C'), dim(45.8, 'B+'), dim(49.6, 'C+'), dim(49.4, 'C+'), dim(55.6, 'A+'), dim(53.7, 'B+')), strengthTags: ['快速', '中文'] },
    ],
  },
  {
    vendorId: 'minimax',
    vendorName: 'MiniMax',
    officialUrl: 'https://api.minimax.chat/v1',
    models: [
      { id: 'minimax-m3-1-flash', name: 'MiniMax-M3.1-Flash', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(58.9, 'B+'), dim(49.6, 'A'), dim(58.6, 'B'), dim(57.3, 'B'), dim(51.6, 'B+'), dim(57.8, 'A')), strengthTags: ['做题', '快速'] },
      { id: 'minimax-m3', name: 'MiniMax-M3', tier: 'C', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(44.8, 'C'), dim(42.9, 'B+'), dim(48.4, 'D'), dim(38.5, 'D'), dim(44.8, 'C+'), dim(44.8, 'B')), strengthTags: ['文案'] },
    ],
  },
  {
    vendorId: 'xai',
    vendorName: 'xAI',
    officialUrl: 'https://api.x.ai/v1',
    models: [
      { id: 'grok-4-7', name: 'Grok 4.7', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(48.0, 'C+'), dim(48.3, 'A'), dim(63.7, 'A'), dim(61.8, 'B+'), dim(58.2, 'S'), dim(66.0, 'SS')), strengthTags: ['前端', '编程'] },
    ],
  },
  {
    vendorId: 'mistral',
    vendorName: 'Mistral AI',
    officialUrl: 'https://api.mistral.ai/v1',
    models: [
      { id: 'mistral-large-4-preview', name: 'Mistral Large 4 Preview', tier: 'C+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(41.0, 'C'), dim(44.6, 'B+'), dim(54.3, 'B'), dim(21.3, 'D'), dim(52.0, 'B+'), dim(47.4, 'B')), strengthTags: ['文案'] },
      { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(28.9, 'D'), dim(39.7, 'C+'), dim(19.9, 'D'), dim(9.0, 'D'), dim(28.9, 'D'), dim(31.6, 'D')), strengthTags: ['文案'] },
      { id: 'mistral-small-4', name: 'Mistral Small 4', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(24.8, 'D'), dim(25.7, 'D'), dim(18.3, 'D'), dim(6.0, 'D'), dim(27.7, 'D'), dim(34.8, 'D')), strengthTags: ['文案'] },
    ],
  },
  {
    vendorId: 'stepfun',
    vendorName: 'StepFun / 阶跃星辰',
    officialUrl: 'https://api.stepfun.com/v1',
    models: [
      { id: 'step-5-preview', name: 'Step 5 Preview', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(54.4, 'B'), dim(53.3, 'S'), dim(59.4, 'B+'), dim(37.4, 'D'), dim(50.2, 'B+'), dim(58.2, 'A')), strengthTags: ['做题'] },
      { id: 'step-3-7-flash', name: 'Step 3.7 Flash', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(29.0, 'D'), dim(37.1, 'C+'), dim(23.7, 'D'), dim(7.7, 'D'), dim(27.8, 'D'), dim(37.9, 'D')), strengthTags: ['快速'] },
      { id: 'step3-vl-10b', name: 'Step3 VL 10B', tier: 'NA', contextWindow: 32_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['reasoning', 'vision'], scores: neutralScores(), strengthTags: ['多模态', '小模型'], imageInput: true },
    ],
  },
]

/** 面板厂家 Tab 的展示顺序（产品指定的九家在前，其余目录厂商随后，Custom 永远最后）。 */
export const VENDOR_TAB_ORDER: readonly string[] = [
  'anthropic', 'openai', 'google', 'deepseek', 'alibaba', 'moonshot', 'zhipu', 'xiaomi', 'minimax',
  'doubao', 'agnes',
]

/** 把任意 id 归一化成可比形态：小写 + 去掉分隔符。 */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 在一家厂商的目录里匹配一个上游模型 id（先精确 id、再归一化、再按显示名）。 */
export function matchTemplateModel(vendor: TemplateVendor, modelId: string): TemplateModel | undefined {
  for (const model of vendor.models) {
    if (model.id === modelId) return model
  }
  const wanted = normalizeModelId(modelId)
  for (const model of vendor.models) {
    if (normalizeModelId(model.id) === wanted) return model
  }
  for (const model of vendor.models) {
    if (normalizeModelId(model.name) === wanted) return model
  }
  return undefined
}

/** 目录条目 → 路由层的 ModelInfo 视图。 */
export function templateModelToInfo(vendor: TemplateVendor, model: TemplateModel): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    tier: model.tier,
    contextWindow: model.contextWindow,
    costPer1kInput: model.costPer1kInput,
    costPer1kOutput: model.costPer1kOutput,
    capabilities: [...model.capabilities],
    scores: { ...model.scores },
    ...(model.strengths !== undefined ? { strengths: model.strengths } : {}),
    ...(model.strengthTags !== undefined ? { strengthTags: [...model.strengthTags] } : {}),
    ...(model.imageInput === true ? { imageInput: true } : {}),
    ...(model.imageOutput === true ? { imageOutput: true } : {}),
    ...(model.videoOutput === true ? { videoOutput: true } : {}),
  }
}

/** 目录里查不到的模型：六维未知——中性分 50 + NA 评级，面板如实显示「未收录」。 */
export function unknownModelInfo(id: string, name?: string): ModelInfo {
  const scores = {} as DimensionSet
  for (const key of DIMENSION_KEYS) scores[key] = dim(50, 'NA')
  return {
    id,
    name: name ?? id,
    tier: 'NA',
    contextWindow: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    scores,
  }
}
