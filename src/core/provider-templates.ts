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
import { listPriceOf } from './pricing.ts'

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
  /**
   * 官网 / 控制台地址（去这家申请 key 的地方）。
   * 面板里那行「官网 ↗」就点到这里——不给链接，用户只能自己去搜，
   * 而搜出来的常常是别人的中转站。
   */
  homepage?: string
  /**
   * 模型清单是否公开可取：设为 true 时面板不用密钥就能「拉取模型」，
   * 因为这一家的 /models 本来就是匿名可读的（OpenCode Zen 就是这样）。
   */
  /**
   * 不显示「中转站」这一行：国内厂商本来就直连，免费池和本机服务也没有中转的概念，
   * 硬塞一个空地址框只会让人以为哪里没填。
   */
  noRelay?: boolean
  /** 左栏分组：free = 免费池（单独一节），缺省进「内置」。 */
  group?: 'free'
  /** 面板里的一句话说明（这家是什么、要不要 key）。 */
  note?: string
  publicModels?: boolean
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
    homepage: 'https://console.anthropic.com/settings/keys',
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
    homepage: 'https://platform.openai.com/api-keys',
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
    homepage: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', tier: 'SS', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: dims(dim(78.5, 'SSS'), dim(46.8, 'A'), dim(75.1, 'SS'), dim(80.1, 'SS'), dim(62.7, 'SS'), dim(71.2, 'SSS')), strengthTags: ['推理', '多模态'] },
      { id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision'], scores: dims(dim(58.0, 'B+'), dim(45.9, 'B+'), dim(56.9, 'B'), dim(52.6, 'B+'), dim(47.3, 'B'), dim(64.8, 'S')), strengthTags: ['多模态', '快速'] },
      { id: 'gemini-3-5-flash-lite', name: 'Gemini 3.5 Flash-Lite', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision'], scores: dims(dim(29.1, 'D'), dim(43.3, 'B'), dim(31.5, 'D'), dim(12.2, 'D'), dim(33.5, 'D'), dim(52.6, 'B+')), strengthTags: ['快速'] },
    ],
  },
  {
    vendorId: 'meta',
    vendorName: 'Muse AI',
    officialUrl: '',
    homepage: 'https://www.meta.ai',
    models: [
      { id: 'muse-wonder', name: 'Muse Wonder', tier: 'S', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(71.2, 'S'), dim(53.0, 'S'), dim(71.0, 'S'), dim(66.1, 'A'), dim(61.6, 'SS'), dim(62.7, 'S')), strengthTags: ['做题'] },
      { id: 'muse-spark-1-3', name: 'Muse Spark 1.3', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(61.4, 'A'), dim(48.4, 'A'), dim(64.1, 'A'), dim(61.3, 'B+'), dim(58.1, 'S'), dim(62.5, 'S')), strengthTags: ['做题'] },
      { id: 'muse-glimmer', name: 'Muse Glimmer', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(28.9, 'D'), dim(44.0, 'B+'), dim(26.0, 'D'), dim(7.8, 'D'), dim(31.7, 'D'), dim(33.6, 'D')), strengthTags: ['小模型'] },
    ],
  },
  {
    vendorId: 'deepseek',
    noRelay: true,
    vendorName: '深度求索 DeepSeek',
    officialUrl: 'https://api.deepseek.com/v1',
    homepage: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-1-pro', name: '深度求索 DeepSeek V4.1 Pro', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['编程', '推理'] },
      { id: 'deepseek-v4-1-flash-1017', name: '深度求索 DeepSeek Flash', tier: 'A+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(62.4, 'A'), dim(51.8, 'A+'), dim(69.4, 'S'), dim(68.6, 'A+'), dim(60.1, 'SS'), dim(52.4, 'B+')), strengthTags: ['编程', '智能体'] },
      { id: 'deepseek-v4-pro-0813', name: '深度求索 DeepSeek V4 Pro', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(53.9, 'B'), dim(48.0, 'A'), dim(57.2, 'B+'), dim(41.1, 'D'), dim(49.7, 'B+'), dim(50.4, 'B')), strengthTags: ['推理'] },
    ],
  },
  {
    // 火山方舟（豆包）。注意：方舟上每个模型常以「推理接入点」id 暴露，
    // 面板里的「测试连接并拉取模型」会列出账号可用的真实 id，勾选即可。
    vendorId: 'doubao',
    noRelay: true,
    vendorName: '豆包 Doubao',
    officialUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    homepage: 'https://console.volcengine.com/ark',
    models: [
      { id: 'doubao-seed-2-1', name: '豆包 Doubao Seed 2.1', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: neutralScores(), strengthTags: ['智能体', '多模态'], imageInput: true },
      { id: 'doubao-seed-1-6', name: '豆包 Seed 1.6', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'], scores: neutralScores(), strengthTags: ['智能体', '多模态'], imageInput: true },
      { id: 'doubao-seed-1-6-flash', name: '豆包 Seed 1.6 Flash', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'fast', 'vision'], scores: neutralScores(), strengthTags: ['快速', '多模态'], imageInput: true },
    ],
  },
  {
    // 百度千帆：ERNIE Speed / Lite 系列长期免费，OpenAI 兼容端点在 /v2。
    vendorId: 'baidu',
    noRelay: true,
    group: 'free',
    note: '百度千帆：ERNIE Speed / Lite 系列长期免费（中文任务够用），OpenAI 兼容端点在 qianfan.baidubce.com/v2。免费名单会调整，建议先点「拉取模型」看当前有什么。',
    vendorName: '百度千帆 ERNIE',
    officialUrl: 'https://qianfan.baidubce.com/v2',
    homepage: 'https://console.bce.baidu.com/qianfan/overview',
    models: [
      { id: 'ernie-speed-128k', name: '百度 ERNIE-Speed 免费', tier: 'NA', contextWindow: 128000, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['coding', 'fast'], scores: neutralScores(), strengthTags: ['免费', '快速', '中文'] },
      { id: 'ernie-speed-pro-128k', name: '百度 ERNIE-Speed Pro 免费', tier: 'NA', contextWindow: 128000, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['coding', 'fast'], scores: neutralScores(), strengthTags: ['免费', '快速', '中文'] },
      { id: 'ernie-lite-8k', name: '百度 ERNIE-Lite 免费', tier: 'NA', contextWindow: 8000, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['fast'], scores: neutralScores(), strengthTags: ['免费', '快速', '中文'] },
    ],
  },
  {
    // 硅基流动：一批开源小模型常驻免费额度。
    vendorId: 'siliconflow',
    noRelay: true,
    group: 'free',
    note: '硅基流动（国内平台）：Qwen、GLM、DeepSeek 蒸馏版这批开源小模型常驻免费额度，能力不算强但稳定、不要钱，适合当「极致便宜」档的兜底。填自己的 key 后先点上面的「拉取模型」看当前免费名单。',
    vendorName: '硅基流动 SiliconFlow',
    officialUrl: 'https://api.siliconflow.cn/v1',
    homepage: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'Qwen/Qwen2.5-7B-Instruct', name: '硅基 Qwen2.5-7B 免费', tier: 'NA', contextWindow: 32000, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['coding'], scores: neutralScores(), strengthTags: ['免费', '小模型'] },
      { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', name: '硅基 DeepSeek-R1-7B 免费', tier: 'NA', contextWindow: 32000, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['reasoning'], scores: neutralScores(), strengthTags: ['免费', '推理', '小模型'] },
    ],
  },
  {
    // OpenRouter：带 :free 后缀的模型由它自己补贴（有频率限制，需要能连上它的出口）。
    vendorId: 'openrouter',
    noRelay: true,
    group: 'free',
    note: 'OpenRouter 免费池：带 :free 后缀的模型由 OpenRouter 自己补贴，不按 token 计费，但有每分钟次数限制、且需要能连上境外出口。胜在型号多、能顺手用上 GPT / Claude 的免费额度。',
    vendorName: 'OpenRouter 免费池',
    officialUrl: 'https://openrouter.ai/api/v1',
    homepage: 'https://openrouter.ai/keys',
    models: [
      { id: 'deepseek/deepseek-r1:free', name: 'OpenRouter DeepSeek-R1 免费', tier: 'NA', contextWindow: 163840, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['reasoning'], scores: neutralScores(), strengthTags: ['免费', '推理'] },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'OpenRouter Llama-3.3-70B 免费', tier: 'NA', contextWindow: 65536, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['coding'], scores: neutralScores(), strengthTags: ['免费', '开源'] },
    ],
  },
  {
    vendorId: 'opencode',
    noRelay: true,
    note: 'OpenCode 官方网关：模型清单公开可拉（不填 key 也能拉）。注意它的免费型号只对官方客户端开放，付费 / Go 模型填自己的 key 才能调用。',
    vendorName: 'OpenCode Zen',
    officialUrl: 'https://opencode.ai/zen/v1',
    homepage: 'https://opencode.ai/auth',
    publicModels: true,
    // 目录里不放静态清单：这一家有 80 多个模型、且随时增减，
    // 面板点「拉取模型」就能把真实的 id / 名字 / 上下文窗口拿回来。
    models: [],
  },
  {
    // Agnes（模型清单来自本机真实 /models 探测，见 vendors.spec 同源验证）。
    vendorId: 'agnes',
    noRelay: true,
    vendorName: 'Agnes',
    officialUrl: 'https://api.agnes-ai.cn/v1',
    homepage: 'https://agnes-ai.cn',
    models: [
      { id: 'agnes-3-0-flash', name: 'Agnes 3.0 Flash', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['fast', 'coding', 'tool-use'], scores: neutralScores(), strengthTags: ['快速', '编程'] },
      { id: 'agnes-2-5-pro', name: 'Agnes 2.5 Pro', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['推理'] },
      { id: 'agnes-image-2-5-flash', name: 'Agnes Image 2.5 Flash', tier: 'NA', contextWindow: 8_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['image_gen'], scores: neutralScores(), strengthTags: ['图像生成'], imageOutput: true },
    ],
  },
  {
    vendorId: 'inkling',
    vendorName: 'Inkling',
    officialUrl: '',
    homepage: 'https://thinkingmachines.ai',
    models: [
      { id: 'inkling', name: 'Inkling', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['reasoning'], scores: neutralScores(), strengthTags: ['做题'] },
      { id: 'inkling-small', name: 'Inkling Small', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['reasoning'], scores: neutralScores(), strengthTags: ['小模型'] },
    ],
  },
  {
    vendorId: 'moonshot',
    noRelay: true,
    vendorName: '月之暗面 Moonshot',
    officialUrl: 'https://api.moonshot.cn/v1',
    homepage: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { id: 'kimi-k3', name: '月之暗面 Kimi K3', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['编程'] },
      { id: 'kimi-k3-1-pro', name: '月之暗面 Kimi K3.1 Pro', tier: 'S', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(73.2, 'SS'), dim(56.6, 'SS'), dim(75.0, 'SS'), dim(70.5, 'A+'), dim(57.0, 'A+'), dim(64.8, 'S')), strengthTags: ['做题', '推理'] },
    ],
  },
  {
    vendorId: 'alibaba',
    noRelay: true,
    vendorName: '通义千问 Qwen',
    officialUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    homepage: 'https://bailian.console.aliyun.com/',
    models: [
      { id: 'qwen3-8-vl', name: '通义千问 Qwen3.8-VL', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'vision'], scores: neutralScores(), strengthTags: ['多模态'], imageInput: true },
      { id: 'qwen3-8-max-0902', name: '通义千问 Qwen3.8-Max', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(60.5, 'A'), dim(50.2, 'A+'), dim(63.8, 'A'), dim(58.4, 'B'), dim(56.1, 'A+'), dim(56.0, 'A')), strengthTags: ['文案'] },
      { id: 'qwen3-8-flash-next', name: '通义千问 Qwen3.8 Flash Next', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(53.1, 'B'), dim(48.5, 'A+'), dim(52.6, 'B'), dim(36.7, 'C'), dim(53.7, 'A'), dim(55.1, 'C+')), strengthTags: ['快速', '中文'] },
    ],
  },
  {
    vendorId: 'xiaomi',
    noRelay: true,
    vendorName: '小米 Xiaomi',
    officialUrl: '',
    homepage: 'https://platform.xiaomimimo.com',
    models: [
      { id: 'mimo-v2-6-pro', name: '小米 MiMo 2.6 Pro', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(62.7, 'A'), dim(49.6, 'A'), dim(63.7, 'A'), dim(66.2, 'A'), dim(56.4, 'A+'), dim(54.2, 'B+')), strengthTags: ['推理'] },
      { id: 'mimo-v2-6-flash', name: '小米 MiMo 2.6 Flash', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(56.2, 'B+'), dim(43.0, 'B'), dim(57.2, 'B+'), dim(49.5, 'C+'), dim(53.5, 'A'), dim(43.7, 'C+')), strengthTags: ['便宜', '批量'] },
    ],
  },
  {
    vendorId: 'zhipu',
    noRelay: true,
    vendorName: '智谱 Z.ai',
    officialUrl: 'https://open.bigmodel.cn/api/paas/v4',
    homepage: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-4-5-flash', name: '智谱 GLM-4.5-Flash 免费', tier: 'NA', contextWindow: 128000, costPer1kInput: 0, costPer1kOutput: 0, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['免费', '中文'] },
      { id: 'glm-5-3', name: '智谱 GLM-5.3', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(56.1, 'B+'), dim(48.4, 'A'), dim(64.3, 'A'), dim(39.8, 'D'), dim(57.2, 'S'), dim(57.1, 'A')), strengthTags: ['文案', '中文'] },
      { id: 'glm-5-3-flash', name: '智谱 GLM-5.3 Flash', tier: 'B', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(43.7, 'C'), dim(45.8, 'B+'), dim(49.6, 'C+'), dim(49.4, 'C+'), dim(55.6, 'A+'), dim(53.7, 'B+')), strengthTags: ['快速', '中文'] },
    ],
  },
  {
    vendorId: 'minimax',
    noRelay: true,
    vendorName: 'MiniMax',
    officialUrl: 'https://api.minimax.chat/v1',
    homepage: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    models: [
      { id: 'minimax-m3-1-preview', name: '稀宇 MiniMax M3.1 Preview', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['推理'] },
      { id: 'minimax-m3-1-flash', name: '稀宇 MiniMax M3.1 Flash', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(58.9, 'B+'), dim(49.6, 'A'), dim(58.6, 'B'), dim(57.3, 'B'), dim(51.6, 'B+'), dim(57.8, 'A')), strengthTags: ['做题', '快速'] },
    ],
  },
  {
    vendorId: 'xai',
    vendorName: 'xAI',
    officialUrl: 'https://api.x.ai/v1',
    homepage: 'https://console.x.ai/',
    models: [
      { id: 'grok-4-7-mini', name: 'Grok 4.7 Mini', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'fast'], scores: neutralScores(), strengthTags: ['快速', '前端'] },
      { id: 'grok-4-7', name: 'Grok 4.7', tier: 'A', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: dims(dim(48.0, 'C+'), dim(48.3, 'A'), dim(63.7, 'A'), dim(61.8, 'B+'), dim(58.2, 'S'), dim(66.0, 'SS')), strengthTags: ['前端', '编程'] },
    ],
  },
  {
    vendorId: 'mistral',
    vendorName: 'Mistral AI',
    officialUrl: 'https://api.mistral.ai/v1',
    homepage: 'https://console.mistral.ai/api-keys/',
    models: [
      { id: 'mistral-large-4-preview', name: 'Mistral Large 4 Preview', tier: 'C+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(41.0, 'C'), dim(44.6, 'B+'), dim(54.3, 'B'), dim(21.3, 'D'), dim(52.0, 'B+'), dim(47.4, 'B')), strengthTags: ['文案'] },
      { id: 'mistral-small-4', name: 'Mistral Small 4', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(24.8, 'D'), dim(25.7, 'D'), dim(18.3, 'D'), dim(6.0, 'D'), dim(27.7, 'D'), dim(34.8, 'D')), strengthTags: ['文案'] },
    ],
  },
  {
    vendorId: 'tencent',
    noRelay: true,
    vendorName: '腾讯混元 Hunyuan',
    officialUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    homepage: 'https://console.cloud.tencent.com/hunyuan/api-key',
    models: [
      { id: 'hy4-flash', name: '腾讯 Hy4 Flash', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'fast'], scores: neutralScores(), strengthTags: ['快速'] },
      { id: 'hy4-preview', name: '腾讯 Hy4 Preview', tier: 'NA', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning', 'tool-use'], scores: neutralScores(), strengthTags: ['推理'] },
    ],
  },
  {
    vendorId: 'stepfun',
    noRelay: true,
    vendorName: '阶跃星辰 StepFun',
    officialUrl: 'https://api.stepfun.com/v1',
    homepage: 'https://platform.stepfun.com/interface-key',
    models: [
      { id: 'step-5-preview', name: '阶跃星辰 Step 5 Preview', tier: 'B+', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(54.4, 'B'), dim(53.3, 'S'), dim(59.4, 'B+'), dim(37.4, 'D'), dim(50.2, 'B+'), dim(58.2, 'A')), strengthTags: ['做题'] },
      { id: 'step-3-7-flash', name: '阶跃星辰 Step 3.7 Flash', tier: 'D', contextWindow: 128_000, costPer1kInput: null, costPer1kOutput: null, capabilities: ['coding', 'reasoning'], scores: dims(dim(29.0, 'D'), dim(37.1, 'C+'), dim(23.7, 'D'), dim(7.7, 'D'), dim(27.8, 'D'), dim(37.9, 'D')), strengthTags: ['快速'] },
    ],
  },
]

/** 面板厂家 Tab 的展示顺序（产品指定的九家在前，其余目录厂商随后，Custom 永远最后）。 */
/**
 * 左栏厂家的展示顺序：按知名度排，不按字母也不按内部 id。
 *
 * 排序依据是「普通用户听说过的概率」：国际三巨头 → 马斯克 / Meta →
 * 国内第一梯队（DeepSeek、豆包、通义、Kimi、智谱、混元）→ 其余。
 * 免费池那三家不在这里，它们有自己的分区。
 */
export const VENDOR_TAB_ORDER: readonly string[] = [
  'openai', 'anthropic', 'google',
  'xai', 'meta',
  'deepseek', 'doubao', 'alibaba', 'moonshot', 'zhipu', 'tencent', 'minimax', 'xiaomi',
  'mistral', 'stepfun',
  'opencode', 'agnes', 'inkling',
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

/**
 * 全局找一份内置档案：不管模型挂在哪个厂家下面，只认精确/归一化/显示名三级命中。
 *
 * 要连别名、发版快照、同族一起认，用 `model-match.ts` 的 `resolveModelProfile`：
 * 面板与池合成走的都是那一条，这个函数只留给「只要精确命中」的调用方。
 */
export function findModelProfile(modelId: string): { vendor: TemplateVendor, model: TemplateModel } | undefined {
  for (const vendor of PROVIDER_TEMPLATES) {
    const model = matchTemplateModel(vendor, modelId)
    if (model !== undefined) return { vendor, model }
  }
  return undefined
}

/** 目录条目 → 路由层的 ModelInfo 视图。 */
export function templateModelToInfo(vendor: TemplateVendor, model: TemplateModel): ModelInfo {
  const price = listPriceOf(model.id)
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
    // 榜单估算价：目录未收录时为未定价，面板显示 —，绝不冒充 0。
    ...(price === undefined ? {} : { price }),
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
