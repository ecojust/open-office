"""Industry-specific, original editable artwork for the presentation gallery.

18 industries × 5 use cases complement the ten standalone visual themes. Each
industry has its own motif and concrete slide copy; layout choices are spread
across six covers, ten content arrangements, and five closing compositions.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Industry:
    id: str
    name: str
    accent: str
    ink: str
    pale: str
    names: tuple[str, ...]
    subjects: tuple[str, ...]
    focus: tuple[str, str, str]
    detail: tuple[str, str, str]
    metrics: tuple[str, str, str]
    stages: tuple[str, str, str]
    closing: str


INDUSTRIES = [
    Industry('software', '软件科技', '#5468CE', '#172650', '#EDF0FD',
        ('软件科技·数字化战略', '软件科技·产品发布', '软件科技·增长复盘', '软件科技·系统架构', '软件科技·研发路线'),
        ('让技术连接业务价值', '从用户问题到产品答案', '用数据看见产品成长', '构建可靠的服务体系', '把产品愿景变成里程碑'),
        ('用户场景', '核心能力', '交付价值'), ('梳理用户任务与关键痛点', '说明核心功能与技术边界', '用可衡量的结果验证价值'),
        ('活跃用户', '服务可用率', '交付周期'), ('需求验证', '版本迭代', '规模交付'), '让技术成为解决问题的力量'),
    Industry('health', '医疗健康', '#168985', '#174448', '#E9F7F3',
        ('医疗健康·服务规划', '医疗健康·诊疗方案', '医疗健康·质量汇报', '医疗健康·就诊流程', '医疗健康·专科建设'),
        ('以患者为中心的服务', '让诊疗路径更加清晰', '用质量指标推动改善', '连接每一次就诊体验', '构建可持续的健康服务'),
        ('患者需求', '服务能力', '健康结果'), ('识别患者人群与就医需求', '梳理诊疗资源与团队分工', '明确质量与体验评价方式'),
        ('服务覆盖', '随访完成率', '患者满意度'), ('评估与分诊', '诊疗与照护', '随访与改善'), '专业有温度，服务有回响'),
    Industry('education', '教育培训', '#DD8A30', '#594127', '#FFF5E5',
        ('教育培训·课程规划', '教育培训·课程介绍', '教育培训·教学成果', '教育培训·课堂设计', '教育培训·学习计划'),
        ('为每一段成长设计路径', '让知识连接真实生活', '让学习成果清晰可见', '从学习目标到课堂行动', '循序渐进，走向新的能力'),
        ('学习目标', '课程内容', '实践评价'), ('定义学习者应掌握的能力', '组织知识模块与实践任务', '通过作品与反馈检验成长'),
        ('课程完成率', '能力达成度', '学习参与度'), ('激发兴趣', '探究实践', '展示反馈'), '让每一个好奇心都有方向'),
    Industry('finance', '金融服务', '#AB8540', '#263A53', '#F6F2E8',
        ('金融服务·年度策略', '金融服务·客户方案', '金融服务·经营分析', '金融服务·风控框架', '金融服务·业务规划'),
        ('稳健经营，持续创造价值', '让金融服务贴近客户', '用经营数据看清方向', '建立全流程风险管理', '以长期视角规划增长'),
        ('客户洞察', '资产配置', '风险管理'), ('分析客户目标与资金需求', '阐明服务结构与适配逻辑', '识别风险边界与监测机制'),
        ('业务规模', '服务覆盖', '风险指标'), ('识别评估', '分层管理', '监测复盘'), '让稳健成为长期价值的起点'),
    Industry('manufacturing', '智能制造', '#34749B', '#243B4A', '#EAF1F6',
        ('智能制造·工厂规划', '智能制造·设备方案', '智能制造·产线复盘', '智能制造·生产流程', '智能制造·转型路线'),
        ('让生产更智能、更可靠', '以装备升级释放产能', '用现场数据驱动改善', '打通从原料到交付的链路', '从自动化迈向协同制造'),
        ('生产现场', '设备协同', '质量交付'), ('识别产线瓶颈与资源约束', '说明设备连接与调度方式', '建立质量标准与交付节奏'),
        ('设备效率', '一次合格率', '准时交付率'), ('原料准备', '协同生产', '质量检验'), '让每一道工序创造更高价值'),
    Industry('energy', '能源环保', '#35926A', '#214A3C', '#EDF7ED',
        ('能源环保·低碳战略', '能源环保·项目方案', '能源环保·能效报告', '能源环保·碳管理流程', '能源环保·绿色转型'),
        ('以绿色行动连接未来', '让清洁能源走进场景', '用能效数据验证改变', '建立可追踪的减排闭环', '规划下一步绿色增长'),
        ('能源现状', '节能方案', '环境价值'), ('盘点能源结构与排放来源', '设计节能措施与实施范围', '说明减排效果与持续收益'),
        ('综合能耗', '清洁能源占比', '减排进度'), ('盘查基线', '执行改造', '监测优化'), '把绿色愿景落实到每一次行动'),
    Industry('agriculture', '农业食品', '#7C9441', '#3D4B27', '#F4F6E8',
        ('农业食品·乡村规划', '农业食品·农产品推介', '农业食品·丰收报告', '农业食品·溯源流程', '农业食品·种植计划'),
        ('让土地孕育新的可能', '从产地讲好产品故事', '让丰收与品质有据可循', '连接田间与消费者餐桌', '顺应时节，规划每一季'),
        ('产地资源', '品质管理', '市场连接'), ('说明产地条件与资源优势', '建立生产标准与质量控制', '连接产品定位与销售渠道'),
        ('种植面积', '品质达标率', '产销对接率'), ('育种培育', '田间管理', '采收溯源'), '一份耕耘，连接美好生活'),
    Industry('architecture', '建筑空间', '#9C7967', '#4D4440', '#F5EFEB',
        ('建筑空间·城市规划', '建筑空间·设计提案', '建筑空间·项目汇报', '建筑空间·施工组织', '建筑空间·建设进度'),
        ('让空间回应生活方式', '从场地故事到空间表达', '以节点回顾项目进展', '让设计与施工有效协同', '把蓝图变为可达的现场'),
        ('场地研究', '空间策略', '实施路径'), ('分析场地条件与使用人群', '阐明空间关系与设计语言', '明确工序衔接与质量目标'),
        ('完成面积', '节点达成率', '质量验收率'), ('场地勘察', '设计深化', '施工交付'), '让每一处空间承载更好的生活'),
    Industry('logistics', '交通物流', '#3574B4', '#233D5B', '#EAF2FB',
        ('交通物流·网络规划', '交通物流·运输方案', '交通物流·运营分析', '交通物流·履约流程', '交通物流·运力计划'),
        ('让连接更加高效可靠', '为每一次交付设计路线', '从运营数据发现改善点', '打通履约中的每个环节', '以协同运力应对新需求'),
        ('网络节点', '运力协同', '履约体验'), ('梳理服务区域与关键枢纽', '匹配运输资源与需求节奏', '定义时效标准与异常处理'),
        ('准时到达率', '装载利用率', '订单履约率'), ('集货分拣', '干线运输', '末端交付'), '连接每一站，让交付更有把握'),
    Industry('retail', '零售电商', '#CA6A64', '#5E333B', '#FFF0EC',
        ('零售电商·品牌策略', '零售电商·新品上架', '零售电商·销售复盘', '零售电商·会员旅程', '零售电商·大促计划'),
        ('以用户价值驱动生意', '让产品亮点被看见', '从销售表现找到增长点', '连接每一次消费体验', '让关键战役有清晰节奏'),
        ('消费洞察', '商品组合', '全域运营'), ('描述人群画像与购买场景', '明确核心商品与差异卖点', '连接渠道触达与会员运营'),
        ('成交转化率', '复购比例', '客单表现'), ('发现需求', '完成购买', '持续复购'), '让每一次选择都值得期待'),
    Industry('tourism', '文旅酒店', '#3D959C', '#284A56', '#EBF8F5',
        ('文旅酒店·目的地规划', '文旅酒店·旅行推介', '文旅酒店·运营月报', '文旅酒店·服务旅程', '文旅酒店·活动日程'),
        ('让远方成为值得抵达的地方', '从一段故事开始旅行', '用运营细节提升体验', '设计旅程中的每一次相遇', '把美好安排在每一天'),
        ('目的地故事', '体验设计', '服务保障'), ('发掘地方文化与自然特色', '组织路线与核心体验内容', '说明接待能力与服务标准'),
        ('入住表现', '体验满意度', '活动参与度'), ('行前准备', '在地体验', '返程回访'), '下一段美好旅程，从这里出发'),
    Industry('hospitality', '餐饮服务', '#BD703B', '#573F2C', '#FFF5E9',
        ('餐饮服务·门店规划', '餐饮服务·菜单提案', '餐饮服务·经营周报', '餐饮服务·出餐流程', '餐饮服务·开店筹备'),
        ('让好味道连接好生意', '把每一道用心端上餐桌', '以经营细节改善门店表现', '从备料到出品保持一致', '为一场好开业做好准备'),
        ('客群定位', '产品出品', '门店服务'), ('分析就餐场景与顾客偏好', '设计菜品结构与出品标准', '建立人员分工与服务节奏'),
        ('翻台表现', '出品稳定度', '顾客回访率'), ('食材验收', '标准制作', '出餐服务'), '把日常滋味，做成值得回来的理由'),
    Industry('culture', '文化传媒', '#9B639E', '#49334E', '#F7EDF5',
        ('文化传媒·传播策略', '文化传媒·内容提案', '文化传媒·传播报告', '文化传媒·制作流程', '文化传媒·项目排期'),
        ('让好故事遇见更多人', '用创意讲述独特表达', '让传播效果清晰可见', '把创意变成完整作品', '为每一个精彩安排节奏'),
        ('受众洞察', '内容主张', '传播渠道'), ('识别受众兴趣与沟通语境', '建立主题线索与创作风格', '匹配渠道特点与传播节奏'),
        ('内容触达', '互动参与率', '主题认知度'), ('选题策划', '内容制作', '发布传播'), '让表达有力量，让故事有回响'),
    Industry('nonprofit', '公益组织', '#C0776D', '#594047', '#FCF0ED',
        ('公益组织·行动倡议', '公益组织·项目介绍', '公益组织·影响力报告', '公益组织·志愿服务', '公益组织·筹款计划'),
        ('让微小行动汇聚改变', '为真实需求设计公益行动', '把每一份善意变成可见成效', '让志愿力量有序协作', '用透明计划赢得持续支持'),
        ('社会需求', '项目行动', '长期影响'), ('理解服务人群的真实处境', '说明项目活动与资源配置', '追踪成果与社区持续变化'),
        ('服务人数', '志愿时长', '目标达成率'), ('需求调研', '行动协作', '成效反馈'), '每一份参与，都让改变更近一步'),
    Industry('public', '公共服务', '#447D9C', '#294251', '#EEF5F8',
        ('公共服务·发展规划', '公共服务·服务指南', '公共服务·工作报告', '公共服务·办事流程', '公共服务·民生项目'),
        ('让公共服务更可及', '把服务事项说明白', '以务实成果回应期待', '让每一步办理更加清楚', '把民生目标落实到项目'),
        ('公众需求', '服务供给', '治理协同'), ('梳理公众诉求与服务缺口', '优化事项配置与办理体验', '明确部门协作与评价机制'),
        ('服务覆盖率', '办结效率', '群众满意度'), ('咨询受理', '协同办理', '反馈评价'), '以细致服务，回应每一份期待'),
    Industry('research', '科研创新', '#6678A5', '#303E61', '#EFF1F8',
        ('科研创新·课题开题', '科研创新·技术方案', '科研创新·研究成果', '科研创新·实验设计', '科研创新·研究计划'),
        ('从关键问题开启探索', '让研究方法服务于问题', '以证据呈现新的发现', '构建可复核的实验路径', '让探索过程有清晰里程碑'),
        ('研究问题', '方法设计', '证据结论'), ('界定研究范围与核心假设', '说明样本数据与分析方法', '区分研究发现与适用边界'),
        ('样本覆盖', '实验完成度', '结果一致性'), ('提出假设', '实验验证', '讨论结论'), '保持好奇，以证据拓展认知边界'),
    Industry('legal', '法律咨询', '#8A7754', '#363B42', '#F4F1EA',
        ('法律咨询·合规策略', '法律咨询·服务建议', '法律咨询·案件复盘', '法律咨询·审查流程', '法律咨询·治理计划'),
        ('以专业判断守护稳健发展', '让复杂问题拥有清晰路径', '从事实与证据总结经验', '建立有据可循的审查机制', '将治理目标落到具体行动'),
        ('事实梳理', '规则分析', '行动建议'), ('厘清业务场景与事实材料', '识别适用规则与风险边界', '提出可执行的应对与分工'),
        ('审查覆盖率', '事项完成率', '风险整改率'), ('材料收集', '专业审查', '意见反馈'), '以清晰的规则，支持稳健的决策'),
    Industry('people', '人力组织', '#8C6A9B', '#493A55', '#F5EFF8',
        ('人力组织·人才战略', '人力组织·雇主介绍', '人力组织·团队盘点', '人力组织·入职旅程', '人力组织·培养计划'),
        ('让个人成长与组织同频', '让人才看见共同的未来', '用团队洞察支持发展决策', '陪伴每一位伙伴顺利启程', '把潜力培养成可持续能力'),
        ('组织需求', '人才能力', '成长机制'), ('梳理业务目标与岗位需求', '识别能力优势与发展机会', '设计培养反馈与激励方式'),
        ('岗位匹配度', '培养完成率', '团队参与度'), ('相互了解', '融入协作', '持续成长'), '让每一位伙伴找到成长的空间'),
]

PURPOSES = [('strategy', '战略规划'), ('proposal', '产品与服务提案'), ('report', '数据与成果汇报'), ('process', '流程与方法'), ('roadmap', '计划与路线图')]


def motif(c, index, x, y, size, accent, soft, ink):
    """Industry pictograms consist solely of editable rectangles/ellipses/lines."""
    def r(a, b, w, h, fill=None, stroke=None, sw=2): c.rect(x+a*size, y+b*size, w*size, h*size, fill, stroke, sw)
    def e(a, b, w, h, fill=None, stroke=None, sw=2): c.ellipse(x+a*size, y+b*size, w*size, h*size, fill, stroke, sw)
    def l(a, b, u, v, stroke=accent, sw=3): c.line(x+a*size, y+b*size, x+u*size, y+v*size, stroke, sw)
    if index == 0:  # Connected software modules.
        for a, b in [(.08,.14),(.59,.14),(.34,.63)]:
            r(a,b,.28,.21,soft,accent); r(a+.04,b+.045,.11,.025,accent); l(a+.04,b+.12,a+.23,b+.12,accent,2)
        l(.36,.245,.59,.245); l(.22,.35,.48,.63); l(.73,.35,.48,.63)
    elif index == 1:  # Health cross and pulse.
        r(.37,.12,.26,.76,soft); r(.12,.37,.76,.26,soft)
        for a,b,u,v in [(.12,.54,.29,.54),(.29,.54,.39,.38),(.39,.38,.51,.69),(.51,.69,.65,.45),(.65,.45,.72,.54),(.72,.54,.9,.54)]: l(a,b,u,v,accent,5)
    elif index == 2:  # Open book.
        r(.08,.22,.39,.59,soft,accent); r(.52,.22,.39,.59,soft,accent); l(.495,.2,.495,.85,ink,3)
        for j in range(4): l(.15,.35+j*.095,.39,.35+j*.095,accent,2); l(.6,.35+j*.095,.83,.35+j*.095,accent,2)
        e(.69,.06,.13,.13,accent)
    elif index == 3:  # Finance columns and growth.
        for j,h in enumerate([.24,.38,.56]): r(.14+j*.25,.83-h,.14,h,soft,accent)
        for a,b,u,v in [(.12,.43,.39,.33),(.39,.33,.58,.39),(.58,.39,.87,.14),(.72,.14,.87,.14),(.87,.14,.87,.29)]: l(a,b,u,v,accent,4)
    elif index == 4:  # Factory and assembly line.
        r(.1,.44,.8,.37,soft,accent); r(.15,.17,.13,.27,accent); r(.33,.28,.13,.16,accent)
        for j in range(4): r(.18+j*.17,.55,.1,.11,accent)
        l(.08,.91,.93,.91,accent,4)
        for j in range(4): e(.16+j*.2,.86,.08,.08,accent)
    elif index == 5:  # Solar panels, sun, wind turbine.
        e(.64,.08,.22,.22,soft,accent); l(.25,.37,.25,.83,ink,4)
        for a,b in [(.25,.08),(.04,.42),(.48,.4)]: l(.25,.3,a,b,accent,4)
        r(.49,.49,.42,.32,soft,accent)
        for j in [1,2]: l(.49+j*.14,.49,.49+j*.14,.81,accent,2)
        l(.49,.65,.91,.65,accent,2)
    elif index == 6:  # Grain and fields.
        l(.48,.15,.48,.76,accent,4)
        for j in range(3): e(.25,.2+j*.16,.2,.11,soft,accent); e(.52,.27+j*.16,.2,.11,soft,accent)
        for j in range(3): l(.08,.82+j*.05,.91,.82+j*.05,accent,2)
    elif index == 7:  # Architectural elevation and measurement lines.
        for a,b,w,h in [(.15,.36,.2,.45),(.39,.16,.23,.65),(.67,.46,.18,.35)]:
            r(a,b,w,h,soft,accent)
            for j in range(3): l(a+.035,b+.1+j*.1,a+w-.035,b+.1+j*.1,accent,1)
        l(.06,.91,.94,.91,ink,2); l(.06,.87,.06,.95,ink,2); l(.94,.87,.94,.95,ink,2)
    elif index == 8:  # Logistics route and parcel.
        l(.16,.22,.82,.22,accent,4); l(.82,.22,.82,.78,accent,4); l(.16,.78,.82,.78,accent,4)
        for a,b in [(.09,.15),(.75,.15),(.09,.71)]: e(a,b,.14,.14,soft,accent)
        r(.3,.42,.34,.24,soft,ink); l(.47,.42,.47,.66,ink,2); l(.3,.49,.64,.49,ink,2)
    elif index == 9:  # Retail bag and merchandising shelves.
        r(.21,.34,.58,.5,soft,accent); e(.36,.13,.28,.34,None,accent,4); r(.23,.36,.54,.16,soft)
        for j in range(3): r(.3+j*.14,.58,.09,.12,accent)
    elif index == 10:  # Destination sun, mountain, journey.
        e(.66,.13,.2,.2,soft,accent)
        for a,b,u,v in [(.08,.72,.34,.28),(.34,.28,.61,.72),(.45,.72,.69,.39),(.69,.39,.9,.72)]: l(a,b,u,v,accent,3)
        for j in range(3): l(.16,.81+j*.055,.84,.81+j*.055,accent,2)
    elif index == 11:  # Plate and tableware.
        e(.24,.21,.53,.53,soft,accent,3); e(.32,.29,.37,.37,None,accent,2)
        l(.12,.19,.12,.84,accent,4)
        for a in [.07,.12,.17]: l(a,.14,a,.39,accent,2)
        l(.07,.39,.17,.39,accent,2); l(.88,.16,.88,.84,accent,4); l(.82,.16,.82,.48,accent,2); l(.82,.48,.88,.48,accent,2)
    elif index == 12:  # Film frames and spotlight.
        r(.09,.24,.82,.51,soft,accent)
        for j in range(5): r(.15+j*.15,.27,.08,.045,accent); r(.15+j*.15,.68,.08,.045,accent)
        l(.4,.37,.65,.5,accent,4); l(.65,.5,.4,.63,accent,4); l(.4,.37,.4,.63,accent,4)
    elif index == 13:  # People connected around shared work.
        for a,b in [(.42,.08),(.12,.37),(.72,.37)]: e(a,b,.17,.17,soft,accent); r(a-.03,b+.2,.23,.16,soft)
        l(.27,.67,.5,.84,accent,4); l(.5,.84,.76,.67,accent,4); l(.27,.67,.76,.67,accent,4)
    elif index == 14:  # Community hall and public-service windows.
        l(.08,.3,.5,.09,accent,4); l(.5,.09,.92,.3,accent,4); l(.08,.3,.92,.3,accent,4)
        for j in range(4): r(.17+j*.19,.36,.1,.4,soft,accent)
        r(.1,.8,.8,.07,accent); l(.05,.93,.95,.93,ink,2)
    elif index == 15:  # Experimental vessel and observations.
        r(.36,.12,.25,.1,soft,accent); l(.4,.22,.4,.48,accent,3); l(.57,.22,.57,.48,accent,3)
        for a,b,u,v in [(.4,.48,.2,.84),(.57,.48,.8,.84),(.2,.84,.8,.84)]: l(a,b,u,v,accent,3)
        for a,b in [(.4,.63),(.54,.7),(.7,.22),(.17,.33)]: e(a,b,.08,.08,soft,accent)
        l(.3,.72,.7,.72,accent,2)
    elif index == 16:  # Balanced scales.
        l(.5,.12,.5,.84,ink,4); l(.2,.29,.8,.29,accent,4); r(.32,.84,.36,.06,accent)
        for a in [.2,.8]:
            l(a,.29,a-.14,.58,accent,2); l(a,.29,a+.14,.58,accent,2)
            l(a-.14,.58,a+.14,.58,accent,4); e(a-.055,.14,.11,.11,soft,accent)
    else:  # Team skills and development steps.
        for j in range(3):
            a=.12+j*.29; b=.42-j*.13
            e(a,b-.17,.13,.13,soft,accent); r(a-.02,b,.17,.18,soft,accent)
            r(a-.035,.76-j*.1,.2,.08+j*.1,accent)


def cover(c, industry, index, kind):
    accent, ink, pale = industry.accent, industry.ink, industry.pale
    layout = (index + kind * 2) % 6
    title = industry.names[kind].replace('·', '\n')
    if layout == 0:
        c.rect(851,0,429,720,ink); c.rect(850,0,13,720,accent)
        motif(c,index,886,196,326,accent,pale,pale)
        c.text(72,170,740,title,61,ink,True); c.text(76,365,730,industry.subjects[kind],25,ink)
        c.text(76,562,700,'汇报人：你的名字  /  日期：20XX.XX',18,ink)
    elif layout == 1:
        c.rect(0,0,1280,242,ink); c.rect(72,231,72,11,accent)
        c.text(72,71,1100,industry.names[kind],52,'#FFFFFF',True)
        c.text(76,307,730,industry.subjects[kind],29,ink,True)
        for j,focus in enumerate(industry.focus): c.text(77,397+j*45,650,f'0{j+1}  {focus}',22,accent)
        motif(c,index,880,300,303,accent,pale,ink)
        c.text(76,589,800,'汇报人：你的名字  /  日期：20XX.XX',18,ink)
    elif layout == 2:
        c.rect(858,101,350,470,accent); c.rect(884,127,298,418,pale)
        motif(c,index,902,194,263,accent,'#FFFFFF',ink)
        c.line(72,140,790,140,accent,2); c.text(72,190,740,title,59,ink,False)
        c.text(75,389,740,industry.subjects[kind],24,ink)
        c.line(72,482,790,482,accent,1); c.text(75,548,740,'汇报人：你的名字  /  日期：20XX.XX',18,ink)
    elif layout == 3:
        c.ellipse(931,-72,430,430,pale); c.ellipse(-117,463,355,355,pale)
        motif(c,index,514,55,250,accent,pale,ink)
        c.text(120,325,1040,industry.names[kind],53,ink,True,align='center')
        c.text(120,424,1040,industry.subjects[kind],25,ink,align='center')
        c.rect(591,503,98,5,accent); c.text(120,572,1040,'汇报人：你的名字  /  日期：20XX.XX',18,ink,align='center')
    elif layout == 4:
        c.rect(0,0,1280,720,ink); c.rect(0,0,44,720,accent)
        c.text(92,164,770,title,63,'#FFFFFF',True); c.text(96,367,755,industry.subjects[kind],25,pale)
        c.line(95,484,800,484,accent,2); c.text(96,555,755,'汇报人：你的名字  /  日期：20XX.XX',18,pale)
        motif(c,index,881,198,306,accent,pale,pale)
    else:
        c.rect(0,478,1280,242,ink); c.rect(72,86,76,7,accent)
        c.text(72,139,760,title,60,ink,True); c.text(77,369,760,industry.subjects[kind],24,ink)
        motif(c,index,907,110,260,accent,pale,ink)
        for j,focus in enumerate(industry.focus):
            c.text(78+j*390,532,346,f'0{j+1} / {focus}',24,'#FFFFFF',True)
        c.text(77,629,1000,'汇报人：你的名字  /  日期：20XX.XX',18,pale)
    if layout not in {1,4,5}: c.text(76,57,1000,f'OPEN OFFICE  /  {PURPOSES[kind][1]}',14,accent,True)
    if layout == 4: c.text(96,61,1000,f'OPEN OFFICE  /  {PURPOSES[kind][1]}',14,pale,True)


def content(c, industry, index, kind):
    a, ink, pale = industry.accent, industry.ink, industry.pale
    c.rect(72,60,38,7,a); c.rect(115,60,12,7,ink)
    titles = ('从方向到行动', '价值与方案', '关键成果与观察', '关键流程与协作', '阶段目标与交付')
    c.text(72,92,1136,f'{industry.name} / {titles[kind]}',43,ink,True)
    c.text(75,157,1120,industry.subjects[kind],21,ink)
    variant = index % 2
    if kind == 0 and variant == 0:  # Strategy canvas with connected priorities.
        c.rect(72,233,330,353,ink); c.text(100,267,274,'共同目标',27,'#FFFFFF',True)
        c.text(100,335,274,'明确目标人群\n定义成功标准\n聚焦优先行动',23,pale,line_height=1.8)
        for j in range(3):
            y=237+j*117; c.rect(440,y,768,99,pale); c.text(464,y+16,80,f'0{j+1}',30,a,True)
            c.text(551,y+13,610,industry.focus[j],25,ink,True); c.text(551,y+53,610,industry.detail[j],20,ink)
    elif kind == 0:  # Strategic pillars with a shared foundation.
        for j in range(3):
            x=72+j*387; c.rect(x,239,362,278,pale); c.rect(x,239,362,6,a)
            c.text(x+25,274,310,industry.focus[j],28,ink,True); c.text(x+25,338,310,industry.detail[j][:6]+'\n'+industry.detail[j][6:],22,ink,line_height=1.65)
            c.text(x+25,457,310,f'优先事项 0{j+1}',16,a,True)
        c.rect(72,545,1136,49,ink); c.text(94,551,1092,'共同基础：目标一致  ·  资源协同  ·  定期复盘',23,'#FFFFFF',align='center')
    elif kind == 1 and variant == 0:  # Proposal hero and three value rows.
        c.rect(72,234,406,365,pale); motif(c,index,127,267,285,a,'#FFFFFF',ink)
        for j in range(3):
            y=239+j*119; c.text(525,y,655,industry.focus[j],29,ink,True); c.text(527,y+50,650,industry.detail[j],21,ink)
            if j<2:c.line(525,y+96,1208,y+96,a,1)
    elif kind == 1:  # Three modular solution cards.
        for j in range(3):
            x=72+j*387; c.rect(x,234,362,365,pale); c.ellipse(x+28,261,65,65,a)
            c.text(x+28,271,65,f'0{j+1}',24,'#FFFFFF',True,align='center')
            c.text(x+28,354,306,industry.focus[j],29,ink,True)
            c.text(x+28,420,306,industry.detail[j][:6]+'\n'+industry.detail[j][6:],22,ink,line_height=1.7)
            c.line(x+28,560,x+334,560,a,2)
    elif kind == 2 and variant == 0:  # Data dashboard, editable bars and observation list.
        for j in range(3):
            x=72+j*387; c.rect(x,224,362,122,pale); c.text(x+25,243,310,industry.metrics[j],21,ink)
            c.text(x+25,282,310,'待填写',30,a,True)
        c.text(78,382,560,'趋势示意 · 请替换为真实数据',18,ink)
        c.line(78,586,603,586,ink,1)
        for j,h in enumerate([58,88,75,124,149]): c.rect(100+j*98,586-h,53,h,a if j==4 else pale)
        for j in range(3): c.text(669,399+j*64,523,f'0{j+1}  {industry.focus[j]}：补充关键观察',21,ink)
    elif kind == 2:  # Report scorecard, big summary area.
        c.rect(72,235,426,367,ink); c.text(102,269,366,'本期成果摘要',28,'#FFFFFF',True)
        c.text(103,336,363,'在这里填写核心结论\n说明变化与关键原因\n提出下一步改善动作',23,pale,line_height=1.8)
        for j in range(3):
            y=235+j*127; c.rect(535,y,673,110,pale); c.text(560,y+19,385,industry.metrics[j],25,ink,True)
            c.text(562,y+63,394,'口径 / 周期 / 对比基准',17,ink); c.text(972,y+27,206,'待填写',31,a,True)
    elif kind == 3 and variant == 0:  # Horizontal process.
        for j in range(3):
            x=72+j*387; c.rect(x,283,362,240,pale); c.text(x+25,310,312,industry.stages[j],28,ink,True)
            c.text(x+25,373,312,'输入：填写所需信息\n负责：指定协作角色\n输出：明确交付标准',21,ink,line_height=1.65)
            c.ellipse(x+145,220,70,70,a); c.text(x+145,230,70,f'0{j+1}',25,'#FFFFFF',True,align='center')
            if j<2:c.line(x+362,404,x+381,404,a,3)
        c.text(77,565,1100,'协作约定：统一标准、记录问题、明确反馈与升级路径。',22,ink)
    elif kind == 3:  # Vertical swimlane process.
        c.line(122,267,122,555,a,3)
        for j in range(3):
            y=235+j*125; c.ellipse(92,y+18,60,60,a); c.text(92,y+24,60,f'0{j+1}',23,'#FFFFFF',True,align='center')
            c.rect(190,y,1018,104,pale); c.text(218,y+18,301,industry.stages[j],27,ink,True)
            c.text(563,y+19,609,'责任角色：待填写',20,ink); c.text(563,y+54,609,'输入材料 → 执行动作 → 交付标准',20,ink)
    elif kind == 4 and variant == 0:  # Roadmap with milestones.
        c.line(139,322,1134,322,a,4)
        for j in range(3):
            x=72+j*387; c.ellipse(x+117,279,86,86,a); c.text(x+117,301,86,f'0{j+1}',28,'#FFFFFF',True,align='center')
            c.text(x+10,230,342,['近期 / 夯实基础','中期 / 验证推进','远期 / 持续优化'][j],23,ink,True,align='center')
            c.rect(x,397,362,184,pale); c.text(x+24,422,314,industry.stages[j],28,ink,True)
            c.text(x+25,477,310,'关键交付：待填写\n负责人 / 完成日期',21,ink,line_height=1.65)
    else:  # Roadmap as staggered editable schedule.
        labels=['准备阶段','推进阶段','完善阶段']
        for j in range(3): c.text(438+j*248,237,236,labels[j],21,ink,True,align='center')
        for j in range(3):
            y=299+j*96; c.text(78,y+11,330,industry.stages[j],25,ink,True)
            c.rect(434,y,774,65,pale); c.rect(434+j*247,y,278,65,a)
            c.text(451+j*247,y+15,243,'里程碑 / 待填写',20,'#FFFFFF',True,align='center')
        c.text(78,606,1125,'时间刻度与阶段安排可编辑；请按项目实际周期调整。',17,ink)
    c.footer(industry.names[kind],2,ink,pale)


def closing(c, industry, index, kind):
    a, ink, pale = industry.accent, industry.ink, industry.pale
    layout=(kind+index)%5
    if layout==0:
        c.rect(0,0,1280,720,ink); c.rect(0,0,25,720,a)
        motif(c,index,918,100,250,a,pale,pale)
        c.text(80,261,1120,'Open Office',88,'#FFFFFF',True); c.text(85,404,1110,industry.closing,27,pale)
        c.line(85,520,1190,520,a,2); c.text(85,559,1100,'谢谢观看  /  期待交流',21,pale)
    elif layout==1:
        c.rect(76,75,1128,570,None,a,2); c.rect(594,177,92,7,a)
        c.text(140,275,1000,'Open Office',84,ink,False,align='center'); c.text(140,410,1000,industry.closing,26,ink,align='center')
        c.text(140,537,1000,'谢谢观看',21,a,align='center')
    elif layout==2:
        c.rect(0,491,1280,229,ink); motif(c,index,530,47,220,a,pale,ink)
        c.text(120,285,1040,'Open Office',83,ink,True,align='center'); c.text(120,411,1040,'谢谢观看  /  期待交流',23,a,align='center')
        c.text(120,565,1040,industry.closing,27,'#FFFFFF',align='center')
    elif layout==3:
        c.rect(0,0,398,720,ink); motif(c,index,66,219,270,a,pale,pale)
        c.text(458,219,750,'Open Office',78,ink,True); c.text(462,355,746,industry.closing[:12]+'\n'+industry.closing[12:] if len(industry.closing)>16 else industry.closing,27,ink,line_height=1.55)
        c.line(461,488,1195,488,a,2); c.text(462,535,730,'谢谢观看  /  期待交流',21,a)
    else:
        c.ellipse(939,-98,437,437,pale); c.ellipse(-150,492,425,425,pale)
        c.text(120,224,1040,'Open Office',86,ink,True,align='center'); c.rect(600,361,80,6,a)
        c.text(120,418,1040,industry.closing,27,ink,align='center'); c.text(120,559,1040,'谢谢观看',21,a,align='center')


def industry_templates(canvas):
    templates=[]
    for index, industry in enumerate(INDUSTRIES):
        for kind, (purpose_id,purpose_name) in enumerate(PURPOSES):
            def draw(p, industry=industry,index=index,kind=kind):
                first=canvas(p,'#FCFCFA')
                cover(first,industry,index,kind)
                content(canvas(p,'#FCFCFA'),industry,index,kind)
                closing(canvas(p,'#FCFCFA'),industry,index,kind)
                return first
            templates.append((f'{industry.id}-{purpose_id}',industry.names[kind],
                f'{industry.name} · {purpose_name}；{industry.subjects[kind]}。',industry.accent,draw))
    return templates
