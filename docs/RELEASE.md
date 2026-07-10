# Release e Publicacao

Este projeto publica a extensao `sufficit.sufficit-vscode-symposium` no Visual Studio Marketplace por GitHub Actions.

## Secret necessario

No GitHub, configure o secret do repositorio:

- Nome: `VSCE_PAT`
- Valor: Personal Access Token do Azure DevOps com escopo `Marketplace: Manage`

Caminho no GitHub:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

## Fluxo normal

1. Atualize a versao no formato CalVer do projeto:

   ```bash
   npm version 2026.710.3 --no-git-tag-version
   ```

2. Rode a validacao local:

   ```bash
   npm run compile
   npx @vscode/vsce package --no-dependencies --allow-missing-repository
   ```

3. Commit e push da alteracao de versao/codigo.

4. Crie uma tag estavel que bata exatamente com `package.json`:

   ```bash
   git tag v2026.710.3
   git push origin v2026.710.3
   ```

5. O workflow `Publish VS Code Extension` vai:

   - instalar dependencias com `npm ci`
   - conferir que a tag `vX.Y.Z` bate com `package.json`
   - rodar lint, compile e check do webview
   - gerar o VSIX
   - publicar no Visual Studio Marketplace
   - anexar o VSIX ao GitHub Release da tag

## Publicacao manual pelo GitHub

O workflow tambem aceita `workflow_dispatch`, mas so publica quando o input `publish` for `true`.

Use isso apenas para recuperar uma publicacao da mesma versao apos falha operacional. Para releases normais, prefira tags.
