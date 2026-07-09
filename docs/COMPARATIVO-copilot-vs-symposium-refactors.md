# COMPARATIVO — Copilot vs Symposium + lista de refactors

> Status: **draft inicial**
> 
> Objetivo: documentar, de forma enviável, onde o **Symposium** já está bem resolvido e quais refactors o aproximariam do nível de engenharia do **GitHub Copilot** no ecossistema do VS Code.

---

## Resumo executivo

A leitura atual do código sugere o seguinte:

- **Copilot está melhor engenheirado para escala e produto**.
- **Symposium está mais simples, mais legível e mais fácil de evoluir rapidamente**.
- O principal gap do Symposium hoje **não parece ser ideia de arquitetura**, e sim:
  - menor cobertura de testes;
  - mais infra custom de webview/protocolo manual;
  - arquivos grandes concentrando responsabilidades;
  - menos contratos formais entre UI, runtime, sessões e execução.

Em outras palavras:

- **Copilot ganha em robustez sistêmica**.
- **Symposium ganha em clareza e hackabilidade**.

O melhor caminho, portanto, não é “copiar o Copilot”, mas **reduzir acoplamentos e formalizar limites internos**, preservando a simplicidade que o Symposium já tem.

---

## Base objetiva da comparação

### 1) Cobertura aparente de testes

Snapshot observado no repositório local:

- **Symposium**: `7` arquivos em `src/test`
- **Copilot**: `961` arquivos em `test`

Isso não mede qualidade por si só, mas mede **maturidade operacional** e capacidade de refactor seguro.

### 2) Integração com VS Code

O Symposium usa com bastante intensidade uma superfície própria baseada em **webview custom**, com protocolo host ↔ webview e gerenciamento de estado/mensageria manual.

Exemplos observados:

- `src/ui/chatSurface.ts`
- `src/ui/chatHtml.ts`
- `src/ui/webview/index.ts`
- `src/ui/webview/dispatch.ts`
- `src/ui/webview/sessions.ts`
- `src/ui/webview/composer.ts`

Já o Copilot aparenta se apoiar mais nas **APIs nativas/proposed** do VS Code para chat, sessions e language model integration.

Sinais encontrados:

- `ChatResponseStream`
- `chatSessionsProvider`
- `languageModel*`
- `enabledApiProposals` no `package.json`

### 3) Auth e segredos

Aqui o Symposium está bem.

Arquivos observados:

- `src/auth/provider.ts`
- `src/auth/identity.ts`

Pontos positivos:

- uso de `vscode.authentication.registerAuthenticationProvider(...)`;
- token em `context.secrets`;
- perfil/metadata em `globalState`;
- separação razoável entre provider e identidade.

### 4) Arquivos grandes / concentração de responsabilidade

Alguns dos maiores arquivos do Symposium hoje:

- `src/ui/configPanel.ts`
- `src/ui/configViews.ts`
- `src/ui/configI18n.ts`
- `src/ui/webview/sessions.ts`
- `src/ui/surfaceMessages.ts`
- `src/ui/chatController.ts`
- `src/ui/chatSurface.ts`

Isso não é um problema isolado, mas é um forte sinal de que o projeto já chegou no ponto em que **precisa de decomposição preventiva**.

---

## Veredito resumido

| Critério | Melhor hoje |
|---|---|
| Integração nativa com a plataforma VS Code | **Copilot** |
| Cobertura de testes | **Copilot** |
| Escalabilidade arquitetural | **Copilot** |
| Clareza local do código | **Symposium** |
| Facilidade de manutenção por equipe pequena | **Symposium** |
| Organização de auth/segredos | **Symposium** (leve vantagem em clareza) |

---

## Onde o Symposium já está certo

Antes da lista de refactors, vale registrar o que **não deveria ser perdido**:

1. **Baixa dependência externa**
   - a arquitetura é relativamente direta;
   - há bastante uso de VS Code API + Node sem empilhar frameworks desnecessários.

2. **Modelo de adapters por backend**
   - a divisão por backend faz sentido;
   - isso preserva a proposta multiagente/multifornecedor do projeto.

3. **Sessões e runtime como conceitos explícitos**
   - `sessions/runtime` e `sessions/store` já dão uma base boa para evolução.

4. **Auth bem separada**
   - o uso de `SecretStorage` e `AuthenticationProvider` está no caminho certo.

5. **Terminal como superfície real**
   - `src/ui/terminalSession.ts` resolve um problema real de controle bidirecional com CLI visível.

Ou seja: a recomendação não é reescrever, e sim **lapidar os limites internos**.

---

# Refactors prioritários

## P0 — prioridade alta

Esses são os refactors com melhor relação **impacto x risco x retorno**.

---

## P0.1 — Quebrar os “god files” da UI

### Problema

Hoje há concentração de lógica demais em arquivos grandes da UI/webview. Isso dificulta:

- revisão;
- teste unitário;
- onboarding;
- isolamento de bugs;
- reutilização de partes do fluxo.

### Arquivos candidatos

- `src/ui/chatSurface.ts`
- `src/ui/chatController.ts`
- `src/ui/surfaceMessages.ts`
- `src/ui/chatHtml.ts`
- `src/ui/configPanel.ts`
- `src/ui/configViews.ts`
- `src/ui/webview/index.ts`
- `src/ui/webview/dispatch.ts`
- `src/ui/webview/sessions.ts`
- `src/ui/webview/composer.ts`

### Refactor sugerido

Separar por responsabilidade explícita.

Exemplo de decomposição possível:

- `chatSurface.ts`
  - `surfaceBoot.ts`
  - `surfaceTransport.ts`
  - `surfaceContext.ts`
  - `surfaceSessionBinding.ts`
  - `surfaceCommands.ts`

- `chatHtml.ts`
  - `html/shell.ts`
  - `html/templates.ts`
  - `html/csp.ts`

- `configPanel.ts` / `configViews.ts`
  - `config/renderers/*.ts`
  - `config/actions/*.ts`
  - `config/validation/*.ts`

### Ganho esperado

- menor acoplamento;
- redução de regressão por alteração lateral;
- testes mais baratos;
- leitura muito mais rápida.

### Sinal de sucesso

- nenhum arquivo principal de UI com “múltiplas razões para mudar”;
- arquivos menores e mais temáticos;
- menos imports cruzados entre host, render e protocolo.

---

## P0.2 — Formalizar o protocolo host ↔ webview

### Problema

O Symposium tem uma infraestrutura própria de mensagens entre extension host e webview. Isso é normal, mas quando o protocolo cresce sem tipagem/validação explícita suficiente, ele vira fonte de bugs difíceis:

- mensagens faltando campos;
- mudanças incompatíveis silenciosas;
- handlers com responsabilidade difusa;
- dificuldade para testar eventos isolados.

### Refactor sugerido

Criar um contrato central do protocolo.

Exemplo:

- `src/ui/protocol/messages.ts`
- `src/ui/protocol/commands.ts`
- `src/ui/protocol/events.ts`
- `src/ui/protocol/validate.ts`

Definir:

- mensagens do host para a UI;
- mensagens da UI para o host;
- eventos de sessão;
- eventos de progresso;
- payloads opcionais/obrigatórios.

Mesmo sem adicionar dependências novas, já vale ter:

- tipos discriminados bem fechados;
- helpers de criação de mensagem;
- validação defensiva de payload em runtime nos pontos de fronteira.

### Ganho esperado

- menos bugs de integração interna;
- mais previsibilidade ao alterar a UI;
- possibilidade de testes unitários do protocolo sem abrir webview real.

### Inspiração do Copilot

O Copilot parece se apoiar mais em contratos/superfícies nativas e fluxos internos mais especializados, em vez de deixar a conversa inteira dependente de um canal ad hoc implícito.

---

## P0.3 — Aumentar drasticamente a cobertura de testes nas bordas críticas

### Problema

O projeto parece ter uma base de testes ainda pequena para o tamanho atual da superfície funcional.

### Refactor sugerido

Adicionar testes em quatro grupos:

#### A. Auth e identidade

- `src/auth/identity.ts`
- `src/auth/provider.ts`

Casos mínimos:

- salvar token;
- recuperar token;
- limpar sessão;
- manter profile separado de segredo;
- comportamento quando segredos/estado retornam vazio ou corrompido.

#### B. Sessões e persistência

- `src/sessions/runtime.ts`
- `src/sessions/store.ts`

Casos mínimos:

- criar sessão;
- alternar sessão ativa;
- arquivar/pinar;
- recuperar metadados persistidos;
- sobreviver à troca de view/panel.

#### C. Protocolo UI ↔ host

- serialização de mensagens;
- roteamento de handlers;
- fila antes do “ready”; 
- mensagens descartadas/inválidas.

#### D. Terminal e execução

- `src/ui/terminalSession.ts`
- `src/adapters/aiTools/shell.ts`

Casos mínimos:

- enfileiramento antes do boot;
- descoberta de session id;
- envio de texto após bootstrap;
- políticas de comando permitido / fallback / path resolution.

### Ganho esperado

- segurança para refatorar sem medo;
- menos regressão em casos marginais;
- mais facilidade para aceitar contribuições externas.

### Meta prática

Sair de “poucos testes gerais” para uma matriz mínima por subsistema.

---

## P0.4 — Separar melhor runtime de sessão, estado de UI e transporte

### Problema

Hoje algumas responsabilidades tendem a se tocar demais:

- estado lógico da conversa;
- vínculo com webview;
- ciclo de vida da sessão viva;
- persistência;
- atualizações de UI.

Quando isso mistura, fica mais difícil trocar a superfície sem mexer no motor.

### Refactor sugerido

Estabelecer três níveis bem explícitos:

1. **Session Engine**
   - estado da sessão;
   - mensagens;
   - progresso;
   - histórico;
   - anexos/contextos.

2. **Session Runtime**
   - registro de sessões ativas;
   - lifecycle;
   - handoff;
   - sobrevivência à troca de painel/view.

3. **Surface Adapter**
   - webview/sidebar/editor panel;
   - bind/unbind;
   - tradução de eventos do motor para mensagens de tela.

### Sinal de sucesso

- a maior parte da lógica de sessão roda sem webview real;
- trocar “sidebar view” por “panel view” não afeta o core;
- o host trata a UI como cliente, não como lugar onde a lógica mora.

---

## P0.5 — Criar um serviço único e tipado para chaves persistidas

### Problema

Hoje o projeto já usa `workspaceState` e `globalState` em vários pontos. Isso funciona, mas tende a virar:

- chaves string espalhadas;
- inconsistência de naming;
- migrações difíceis;
- leitura/escrita acopladas ao ponto de uso.

### Refactor sugerido

Criar algo como:

- `src/platform/state/keys.ts`
- `src/platform/state/storageService.ts`
- `src/platform/state/migrations.ts`

Com:

- chaves centralizadas;
- getters/setters tipados;
- defaults explícitos;
- suporte a migração de formato.

### Ganho esperado

- menos bugs silenciosos de persistência;
- evolução de schema mais segura;
- padronização do que é segredo, estado global e estado por workspace.

---

## P1 — prioridade média

Esses refactors trazem bastante valor, mas podem vir depois dos P0.

---

## P1.1 — Isolar melhor a infra de terminal da semântica de sessão

### Problema

`src/ui/terminalSession.ts` resolve um caso importante, mas mistura aspectos de:

- terminal VS Code;
- boot de backend;
- descoberta de sessão;
- feed de texto;
- reconstrução de histórico.

### Refactor sugerido

Separar em componentes:

- `TerminalHost`
- `TerminalBootStrategy`
- `TranscriptFollower`
- `SessionDiscovery`
- `TerminalSessionFacade`

### Ganho esperado

- suporte mais limpo a backends diferentes;
- testes melhores;
- menos risco ao mexer em bootstrapping de CLI.

---

## P1.2 — Endurecer contratos dos adapters por backend

### Problema

A ideia de adapters é boa, mas em projetos multi-backend sempre aparece o risco de “interface comum demais” ou “capacidade opcional demais”.

### Refactor sugerido

Classificar melhor capacidades.

Exemplo:

- backend com histórico nativo;
- backend com sessão retomável;
- backend com tool calling;
- backend com terminal ownership;
- backend com streaming estruturado.

Isso pode viver em:

- `src/adapters/capabilities.ts`
- `src/adapters/contracts/*.ts`

### Ganho esperado

- menos `if backend === ...` espalhado;
- decisões de UI mais declarativas;
- onboarding melhor para novos adapters.

---

## P1.3 — Reduzir HTML/CSS/JS inline em favor de módulos internos mais claros

### Problema

`chatHtml.ts` como template única é prático no começo, mas cresce mal.

### Refactor sugerido

Sem necessariamente adotar framework, já vale:

- separar CSP/nonce;
- separar shell HTML;
- separar templates por bloco;
- separar strings estáticas de builders;
- centralizar ids/data-attributes do DOM.

### Ganho esperado

- manutenção visual mais segura;
- menor chance de quebrar estrutura com mudanças simples;
- facilita testes de render e snapshots.

---

## P1.4 — Criar testes de integração de alto valor para fluxos completos

### Sugestões de fluxos

1. abrir surface → criar sessão → enviar mensagem → receber stream → persistir;
2. retomar sessão terminal → descobrir id → seguir transcript;
3. handoff entre backends/agentes;
4. auth login/logout + reflexo na UI;
5. bridge remoto desabilitado/habilitado.

### Ganho esperado

- cobertura de comportamento real;
- proteção contra regressões sistêmicas, não só unitárias.

---

## P1.5 — Melhorar observabilidade interna

### Problema

Projetos de sessão/chat/terminal/webview sofrem muito com bugs de lifecycle. Quando os logs não são consistentes, diagnosticar fica caro.

### Refactor sugerido

Padronizar:

- categorias de log;
- ids de correlação por sessão;
- fases de lifecycle;
- logs de protocolo;
- logs de execução/bridge.

### Ganho esperado

- debug mais rápido;
- reprodução de erro mais simples;
- menos “falhas fantasma”.

---

## P2 — prioridade estrutural / longo prazo

---

## P2.1 — Migrar partes da UX para superfícies mais nativas do VS Code quando fizer sentido

### Observação importante

Isso **não significa abandonar a webview**. O Symposium tem casos legítimos para UI própria.

### Oportunidade

Avaliar onde superfícies nativas podem substituir infra custom:

- sessões em `TreeView` ou lista nativa;
- ações de contexto via comandos/menus nativos;
- alguns fluxos de configuração em QuickPick/InputBox;
- maior integração com APIs de chat/sessão do próprio editor, quando estáveis o suficiente para a proposta do projeto.

### Ganho esperado

- menos código de UI para manter;
- melhor comportamento nativo;
- menor custo de compatibilidade futura.

### Cuidado

A proposta multi-backend do Symposium talvez exija continuar com parte da superfície custom. O alvo aqui é **redução seletiva**, não migração ideológica.

---

## P2.2 — Introduzir ADRs curtas para decisões de arquitetura

### Problema

Projetos que crescem rápido perdem contexto do “porquê” das decisões.

### Refactor sugerido

Adicionar ADRs curtas em `docs/adr/`, por exemplo:

- por que webview própria e não só chat nativo;
- por que terminal visível como superfície primária em alguns backends;
- por que adapters multi-backend com capacidades variáveis;
- por que bridge remoto é opt-in.

### Ganho esperado

- manutenção futura mais racional;
- menos regressão de arquitetura por esquecimento.

---

## P2.3 — Definir métricas de saúde do projeto

Sugestões:

- arquivos acima de X linhas ou X KB;
- cobertura mínima por subsistema;
- tempo para abrir surface;
- tempo para boot de sessão terminal;
- taxa de erro por comando ferramental;
- número de chaves persistidas não centralizadas.

---

# Ordem recomendada de execução

## Fase 1 — ganhar segurança

1. **Formalizar protocolo host ↔ webview**
2. **Criar testes para auth, sessions e terminal**
3. **Centralizar chaves de persistência**

Resultado esperado:

- mais confiança para mexer;
- bugs de integração começam a cair.

## Fase 2 — reduzir acoplamento

4. **Quebrar god files da UI**
5. **Separar runtime, engine e surface adapter**
6. **Isolar infra de terminal**

Resultado esperado:

- arquitetura mais modular sem reescrita radical.

## Fase 3 — polimento estrutural

7. **Melhorar observabilidade**
8. **Adicionar ADRs**
9. **Avaliar migração seletiva para superfícies nativas**

---

# Comparativo “antes/depois” esperado

## Situação atual do Symposium

- bom desenho geral;
- boa clareza local;
- boa base de auth;
- boa noção de sessão/runtime;
- UI poderosa, mas com bastante código custom e arquivos grandes;
- testes ainda insuficientes para a superfície atual.

## Após os refactors sugeridos

O Symposium tenderia a ficar:

- tão simples quanto hoje para evoluir localmente;
- mais seguro para refactor contínuo;
- menos dependente de conhecimento implícito do autor;
- mais próximo do nível de robustez do Copilot, **sem perder a identidade própria**.

---

# Lista curta para enviar como resumo

Se for preciso mandar uma versão resumida em mensagem ou PR discussion:

1. **Aumentar cobertura de testes** nas bordas críticas: auth, sessões, protocolo webview, terminal.
2. **Formalizar o protocolo host ↔ webview** com tipos e validação defensiva.
3. **Quebrar arquivos grandes de UI** em módulos menores por responsabilidade.
4. **Separar melhor engine de sessão, runtime e surface**.
5. **Centralizar persistência tipada** (`globalState`, `workspaceState`, secrets).
6. **Isolar a infra de terminal** da lógica semântica de sessão.
7. **Melhorar observabilidade** e documentar decisões arquiteturais.
8. **Avaliar migração seletiva para APIs nativas do VS Code** onde reduzir custo de manutenção.

---

# Conclusão

O Symposium **não precisa de reescrita**. O projeto já tem fundamentos bons.

O salto de qualidade mais importante agora é sair de uma arquitetura “boa e esperta” para uma arquitetura **boa, explícita e protegida por testes**.

Esse é o principal diferencial que hoje separa o Symposium do nível de maturidade aparente do Copilot.
