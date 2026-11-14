/**
 * Agent 工具：让 DSH 的 Agent 对话式管理 Token 管家。
 *
 * 参考「Agent 预设」的「让 Agent 帮我创建预设模式」：注册一个工具 +
 * 一份运行时技能说明，Agent 据此可以替用户完成「接厂商、勾模型、打标签、
 * 切模式」的全套操作。
 *
 * 纪律：execute 里的一切变更都走与面板相同的保存路径（vendors.json 整表
 * 原子写，密钥空串=保留已存明文），返回人话 + 关键 JSON，供 Agent 转述。
 */
import type { RoutePreview, RoutingMode, VendorConfig } from '../core/types.ts'

/** 工具动作的参数。 */
export interface StewardActionArgs {
  action: string
  vendor_id?: string
  vendor_name?: string
  base_url?: string
  api_key?: string
  enabled_models?: string[]
  model_id?: string
  tags?: string[]
  mode?: string
  /** recommend_model 用：这次任务大概要干什么（一句话即可）。 */
  task?: string
  /** recommend_model 用：default = 按当前模式；subagent = 按子代理档位。 */
  profile?: string
}

/** 一次「该选谁」的咨询输入。 */
export interface RecommendInput {
  /** 任务描述；只用来推断主维度与规模，不做内容解析。 */
  task?: string
  /** default（当前模式）或 subagent（子代理档位）。 */
  profile?: 'default' | 'subagent'
  /** 输入规模（token）；缺省按任务文本估算。 */
  estimatedInputTokens?: number
}

/** 工具背后的服务面（index.ts 注入，全部走面板同款保存路径）。 */
export interface StewardToolDeps {
  /** 当前完整厂家配置（含密钥——只在宿主内存，工具返回值里永不出明文）。 */
  getVendorConfigs(): VendorConfig[]
  /** 整表保存（原子写 + 矩阵重建）。 */
  saveVendorConfigs(vendors: VendorConfig[]): Promise<void>
  /** 切换并持久化全局模式。 */
  setMode(mode: RoutingMode): Promise<void>
  getMode(): RoutingMode
  gatewayBaseUrl(): string | undefined
  /**
   * 只排名、不派发的选路咨询：给 Agent 一个「该把哪个模型派成子代理」的
   * 依据。矩阵未加载时返回 undefined。
   */
  recommend(input: RecommendInput): RoutePreview | undefined
}

const MODES: readonly RoutingMode[] = ['frugal', 'balanced', 'max_power', 'free']

function vendorSummary(vendor: VendorConfig): Record<string, unknown> {
  return {
    vendor_id: vendor.vendorId,
    vendor_name: vendor.vendorName,
    base_url: vendor.customUrl !== '' ? vendor.customUrl : vendor.officialUrl,
    has_key: vendor.apiKey !== '',
    enabled_models: vendor.enabledModels,
    model_tags: vendor.modelTags ?? {},
  }
}

/** 执行一个动作；返回给 Agent 的文本（人话 + 关键 JSON）。 */
export async function executeStewardAction(deps: StewardToolDeps, args: StewardActionArgs): Promise<string> {
  const action = args.action

  if (action === 'show_status') {
    return '当前矩阵状态：\n' + JSON.stringify({
      mode: deps.getMode(),
      gateway: deps.gatewayBaseUrl(),
      vendors: deps.getVendorConfigs().map(vendorSummary),
    }, null, 2)
  }

  if (action === 'set_mode') {
    if (args.mode === undefined || !MODES.includes(args.mode as RoutingMode)) {
      return 'mode 必须是 frugal | balanced | max_power | free'
    }
    await deps.setMode(args.mode as RoutingMode)
    return '调度模式已切换为 ' + args.mode
  }

  if (action === 'add_or_update_vendor') {
    if (args.vendor_id === undefined || args.vendor_id === '') return 'vendor_id 不能为空'
    if (args.base_url === undefined || args.base_url === '') return 'base_url 不能为空（官方地址或中转站均可）'
    const vendors = deps.getVendorConfigs().map((vendor) => ({ ...vendor }))
    const existing = vendors.find((vendor) => vendor.vendorId === args.vendor_id)
    if (existing !== undefined) {
      existing.vendorName = args.vendor_name ?? existing.vendorName
      existing.customUrl = args.base_url
      // api_key 缺省/空串 = 保留已存明文。
      if (args.api_key !== undefined && args.api_key !== '') existing.apiKey = args.api_key
      if (args.enabled_models !== undefined) existing.enabledModels = [...args.enabled_models]
    } else {
      vendors.push({
        vendorId: args.vendor_id,
        vendorName: args.vendor_name ?? args.vendor_id,
        officialUrl: '',
        customUrl: args.base_url,
        apiKey: args.api_key ?? '',
        enabledModels: args.enabled_models !== undefined ? [...args.enabled_models] : [],
        modelTags: {},
      })
    }
    await deps.saveVendorConfigs(vendors)
    const saved = deps.getVendorConfigs().find((vendor) => vendor.vendorId === args.vendor_id)
    return '厂商已保存：\n' + JSON.stringify(saved === undefined ? {} : vendorSummary(saved), null, 2)
  }

  if (action === 'remove_vendor') {
    if (args.vendor_id === undefined || args.vendor_id === '') return 'vendor_id 不能为空'
    const vendors = deps.getVendorConfigs().filter((vendor) => vendor.vendorId !== args.vendor_id)
    if (vendors.length === deps.getVendorConfigs().length) return '厂商不存在: ' + args.vendor_id
    await deps.saveVendorConfigs(vendors)
    return '厂商已移除: ' + args.vendor_id
  }

  if (action === 'set_enabled_models') {
    if (args.vendor_id === undefined || args.vendor_id === '') return 'vendor_id 不能为空'
    if (args.enabled_models === undefined) return 'enabled_models 必须是模型 id 数组'
    const vendors = deps.getVendorConfigs().map((vendor) => ({ ...vendor }))
    const target = vendors.find((vendor) => vendor.vendorId === args.vendor_id)
    if (target === undefined) return '厂商不存在: ' + args.vendor_id
    target.enabledModels = [...args.enabled_models]
    await deps.saveVendorConfigs(vendors)
    return '厂商 ' + args.vendor_id + ' 已启用模型：' + target.enabledModels.join(', ')
  }

  if (action === 'tag_model') {
    if (args.vendor_id === undefined || args.vendor_id === '') return 'vendor_id 不能为空'
    if (args.model_id === undefined || args.model_id === '') return 'model_id 不能为空'
    if (args.tags === undefined || !Array.isArray(args.tags)) return 'tags 必须是字符串数组（如 ["编程", "文案"]）'
    const vendors = deps.getVendorConfigs().map((vendor) => ({ ...vendor }))
    const target = vendors.find((vendor) => vendor.vendorId === args.vendor_id)
    if (target === undefined) return '厂商不存在: ' + args.vendor_id
    const modelTags = { ...(target.modelTags ?? {}) }
    if (args.tags.length === 0) delete modelTags[args.model_id]
    else modelTags[args.model_id] = [...args.tags]
    target.modelTags = modelTags
    await deps.saveVendorConfigs(vendors)
    return '模型 ' + args.model_id + ' 的标签已更新: ' + (modelTags[args.model_id] ?? []).join(', ')
  }

  if (action === 'recommend_model') {
    const profile = args.profile === 'subagent' ? 'subagent' : undefined
    const preview = deps.recommend({
      ...(args.task === undefined || args.task === '' ? {} : { task: args.task }),
      ...(profile === undefined ? {} : { profile }),
    })
    if (preview === undefined) return '模型矩阵还没加载（配置文件缺失或被拒），暂时无法推荐'
    const header = '当前模式：' + preview.mode + (profile === 'subagent'
      ? '｜档位：子代理（agentic 能力 0.6 + 成本 0.4 + 窗口 + 并发分散）'
      : '')
    if (preview.ranked.length === 0) {
      const reasons = preview.rejected.slice(0, 5)
        .map((entry) => entry.provider + '/' + entry.model + ': ' + entry.reason)
        .join('; ')
      return header + '\n没有可用候选' + (reasons === '' ? '' : '：' + reasons)
    }
    const lines = preview.ranked.map((candidate, index) =>
      String(index + 1) + '. ' + candidate.provider + '/' + candidate.model
      + '（分数 ' + String(candidate.score) + '）\n   ' + candidate.reasons.join(' · '))
    return [
      header,
      '推荐顺序：',
      ...lines,
      ...(preview.notes.length === 0 ? [] : ['说明：' + preview.notes.join(' · ')]),
      '',
      profile === 'subagent'
        ? '要让它自动生效：把 dsh-tool-subagent 的 agentOptions 设为 { provider: "steward", model: "steward:subagent" }，之后所有子代理都按这套排序选型。'
        : '这是「本轮请求」的排序；想固定档位就切模式，或直接用上面的 provider/model 直通。',
    ].join('\n')
  }

  return '未知 action: ' + action
    + '（可用: show_status | set_mode | recommend_model | add_or_update_vendor | remove_vendor | set_enabled_models | tag_model）'
}

/** 工具的参数契约（宿主 tools 服务注册用）。 */
export const STEWARD_TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    description: '动作：show_status | recommend_model | add_or_update_vendor | remove_vendor | set_enabled_models | tag_model | set_mode',
  },
  vendor_id: {
    type: 'string',
    description: '厂商 id（add_or_update_vendor / remove_vendor / set_enabled_models / tag_model 时必填）',
  },
  vendor_name: { type: 'string', description: '厂商显示名（可选）' },
  base_url: { type: 'string', description: 'OpenAI 兼容 Base URL（add_or_update_vendor 时必填）' },
  api_key: { type: 'string', description: 'API Key；推荐 env:NAME 引用；留空表示保留已存密钥' },
  enabled_models: {
    type: 'array',
    description: '要启用的模型 id 列表（set_enabled_models 必填）',
  },
  model_id: { type: 'string', description: '要打标签的模型 id（tag_model 时必填）' },
  tags: { type: 'array', description: '擅长标签数组（tag_model 时必填），如 ["编程", "文案", "做题"]' },
  mode: { type: 'string', description: '调度模式：frugal | balanced | max_power | free（free = 免费档，只走零成本模型；set_mode 时必填）' },
  task: {
    type: 'string',
    description: 'recommend_model 用：这次任务大概要干什么（一句话，如「读仓库并改一个测试」「写一篇长文」「看图」）。用于推断主维度与规模',
  },
  profile: {
    type: 'string',
    description: 'recommend_model 用：default（按当前模式）| subagent（子代理档位）。要决定「派哪个模型做子代理」时用 subagent',
  },
}

/**
 * 把上面的 property-map 转成 `tools.register()` 要求的 raw JSON Schema。
 *
 * 宿主的 `register()` 不像 `defineTool()` 那样替你转换：`parameters` 会被
 * 原样当成模型的工具输入契约。直接塞 property-map，模型收到的就不是
 * `{ type: "object", properties: … }`，Anthropic 侧会直接拒掉这个工具。
 */
export function stewardToolParametersJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(
    STEWARD_TOOL_PARAMETERS as Record<string, { type: string, required?: boolean, description?: string }>,
  )) {
    properties[name] = {
      type: spec.type,
      ...(spec.type === 'array' ? { items: { type: 'string' } } : {}),
      ...(spec.description === undefined ? {} : { description: spec.description }),
    }
    if (spec.required === true) required.push(name)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}
