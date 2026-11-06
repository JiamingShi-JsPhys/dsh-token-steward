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
import type { RoutingMode, VendorConfig } from '../core/types.ts'

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
}

const MODES: readonly RoutingMode[] = ['frugal', 'balanced', 'max_power']

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
      return 'mode 必须是 frugal | balanced | max_power'
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

  return '未知 action: ' + action + '（可用: show_status | set_mode | add_or_update_vendor | remove_vendor | set_enabled_models | tag_model）'
}

/** 工具的参数契约（宿主 tools 服务注册用）。 */
export const STEWARD_TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    description: '动作：show_status | add_or_update_vendor | remove_vendor | set_enabled_models | tag_model | set_mode',
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
  mode: { type: 'string', description: '调度模式：frugal | balanced | max_power（set_mode 时必填）' },
}
