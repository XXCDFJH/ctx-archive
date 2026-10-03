# 发布到 VS Code 插件市场

> 已完成的准备:`package.json` 的 `publisher: xxcdfjh`、`version: 1.0.0`、`repository`、`CHANGELOG.md` 均已就绪。

## 一次性登录(需要你的 PAT)

1. 打开 https://dev.azure.com 登录,创建 PAT:
   - Organization: 选择你的组织
   - Scopes: **Marketplace → Manage**
2. 在终端执行(粘贴 PAT):

```
cd E:\Code\Agent\ctx-archive-plugin
npx.cmd vsce login xxcdfjh
```

> 若 publisher 不存在,先执行 `npx.cmd vsce create-publisher xxcdfjh`(同样输入 PAT)。

## 发布

```
npx.cmd tsc -p .
npx.cmd vsce publish --pre-release
```

- `--pre-release`:以预发布版(α)发布 `1.0.0`
- 发布正式版时去掉该参数并递增版本号

## 验证

发布成功后扩展页:
https://marketplace.visualstudio.com/items?itemName=xxcdfjh.ctx-archive
