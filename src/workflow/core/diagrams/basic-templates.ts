import type { DiagramTemplate } from './common.ts'

export const BASIC_TEMPLATES: DiagramTemplate[] = [
  { kind: 'flowchart', id: 'flowchart-basic', title: '分层交付与审批', description: '嵌套子图、局部方向、并行分支、复用样式与连线样式', category: '流程与关系', source: `flowchart LR
%% 子图既可嵌套，也可使用独立的布局方向。
subgraph intake[需求接入]
  direction TB
  request([提交需求]) --> validate{信息完整?}
  validate -- 缺少资料 --> revise[补充信息] --> request
end
subgraph delivery[交付流程]
  direction LR
  subgraph preparation[方案准备]
    direction TB
    design[产品方案] & estimate[成本评估] --> review{{综合评审}}
  end
  review -->|通过| build[实施与验证] --> accepted((完成验收)):::done
  review -.->|需调整| design
end
validate ==>|完整| design & estimate
accepted --> archive[(归档记录)]
%% 属性声明可选原生形状；标签仍按纯文本绘制。
notice@{ shape: note, label: "跨团队复用规则\\n保留审批依据" }
archive --- notice
classDef default fill:#eff6ff,stroke:#334155,font-size:16
classDef decision fill:#fff7dc,stroke:#b45309,stroke-width:2
classDef done fill:#dcfce7,stroke:#15803d
class validate,review decision
class accepted done
style preparation fill:#f0fdf4,stroke:#86a690,stroke-dasharray:5 3
linkStyle 0,1 stroke:#2563eb,stroke-width:3
linkStyle 6 stroke:#b45309,stroke-dasharray:2 3` },
  { kind: 'flowchart', id: 'flowchart-rich-routing', title: '数据处理与图形语法', description: '多种形状、同一行链式连接、双向线、标签与透明度', category: '流程与关系', source: `graph BT
%% 分号分隔语句；引号内的分号和括号会保留。
source[/输入数据/] --> parse["解析; 校验(格式)"]; parse --> ready{可处理?}
ready -- 是 --> worker[[执行子流程]] --> store[(数据仓库)]
ready -. 否 .-> reject[记录错误]
store <--> cache@{ shape: cloud, label: "缓存服务" }
cache <==> archive@{ shape: cylinder, label: "归档存储" }
reject -.- audit[审计记录]
audit === report(汇总报告)
report --> done((结束))
%% 六边形有独立轮廓；属性可声明三角形、星形和文本。
check{{安全检查}} <-.-> worker
alert@{ shape: triangle, label: "风险" } --- check
badge@{ shape: star, label: "重点" } --> report
caption@{ shape: text, label: "从输入到结果\\n所有节点保持可编辑" }
caption --- source
%% 反向、圆形、交叉与隐藏布局连接互相独立。
audit --o store; reject --x audit; store o--o cache
alert x--x check; done <-- report; source <== caption
source ~~~ badge
classDef accent fill:#fef3c7,stroke:#92400e
classDef faint opacity:0.65,stroke:#64748b
class alert,badge accent
class audit,caption faint
style parse fill:rgb(224,242,254),stroke:#0369a1,font-size:18,text-align:center
linkStyle default stroke:#526174
linkStyle 0 stroke:#2563eb,stroke-width:3` },
  { kind: 'sequence', id: 'sequence-basic', title: '订单处理与嵌套分支', description: '激活区、循环、条件、可选步骤、背景片段与编号', category: '流程与关系', source: `sequenceDiagram
title 订单创建与状态反馈
%% actor 用人物符号；participant 用服务卡片，as 设置显示别名。
actor User as 用户
participant App as 业务服务
participant Data as 数据服务
participant Notify as 通知服务
autonumber 10 10
%% 消息中的 + 开始目标激活区，返回消息中的 - 结束发送方激活区。
User->>+App: 提交订单
Note over User,App: 多行说明<br/>先校验，再持久化
%% rect 设置安全背景色；循环内部再放条件分支和可选步骤。
rect rgb(239,246,255)
  loop 最多重试三次
    App->>+Data: 查询库存
    Data-->>-App: 返回库存结果
    alt 库存充足
      App->>Data: 保存订单
      Data-->>App: 确认写入
      opt 用户订阅通知
        App-)Notify: 发送异步通知
        Note right of Notify: 后台完成推送
      end
    else 库存不足
      App->>App: 记录失败原因
      App-->>User: 返回调整建议
    end
  end
end
App-->>-User: 返回处理状态` },
  { kind: 'sequence', id: 'sequence-rich-resilience', title: '并行校验与故障恢复', description: '并行和临界片段、失败中断、嵌套激活、取消与编号恢复', category: '流程与关系', source: `sequenceDiagram
title 批处理并行检查
actor Operator as 操作人员
participant Worker as 任务服务
participant Check as 校验服务
participant Store as 存储服务
autonumber 1 1
Operator->>Worker: 启动任务
activate Worker #dbeafe
%% par/and 表示并行分支；critical/option 表示临界处理与异常分支。
par 校验任务
  Worker->>+Check: 校验格式
  Check-->>-Worker: 返回格式结果
and 读取历史
  Worker->>Store: 查询历史记录
  Store-->>Worker: 返回历史结果
end
%% 同一服务可以嵌套激活，内部处理结束后仍保留外层激活区。
critical 保存一致性结果
  activate Worker #bfdbfe
  Worker->>Worker: 合并检查结果
  Worker->>Store: 提交变更
  Store-->>Worker: 确认提交
  deactivate Worker
option 写入冲突
  Worker-xStore: 取消本次写入
  Note left of Worker: 保留重试上下文
end
%% 暂停只影响消息编号；恢复继续使用此前步长。
autonumber off
Worker-->>Operator: 推送进度
Operator<<-->>Worker: 确认任务状态
autonumber resume
break 用户请求终止
  Operator->>Worker: 终止后续批次
  Worker--)Store: 异步清理临时结果
end
deactivate Worker
Worker-->>Operator: 汇总结果` },
]
