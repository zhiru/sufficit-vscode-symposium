# Diagnósticos de Histórico OpenAI

## O Que Este Aviso Significa

O Symposium mantém o transcript salvo sem alterações, mas pode precisar reorganizar uma pequena parte do histórico da requisição antes de enviá-la para um backend compatível com OpenAI.

APIs compatíveis com OpenAI exigem que chamadas de ferramenta e resultados de ferramenta apareçam em pares estritos. Sessões salvas antigas, turns interrompidos, transcripts importados ou histórico recortado podem deixar um resultado de ferramenta sem a chamada original, ou uma chamada de ferramenta sem o resultado correspondente dentro da janela enviada.

Quando isso acontece, o Symposium dobra os itens inseguros em um resumo de texto simples para a requisição de saída. O transcript persistido não é editado.

## Contadores

**folded_orphan_tools** conta mensagens de resultado de ferramenta que não tinham mais uma chamada de ferramenta correspondente no histórico da requisição. Elas são dobradas em texto para evitar rejeição pelo provedor.

**folded_missing_tool_calls** conta mensagens do assistente com chamadas de ferramenta cujo resultado correspondente estava ausente no histórico da requisição. Elas também são dobradas em texto.

**orphan_tools** e **missing_tool_results** são contadores de validação do envio final. Se aparecerem, o Symposium detectou pareamento inválido na requisição que seria enviada e informa o que encontrou.

## Por Que Acontece

Causas comuns:

- Reabrir uma sessão salva que passou por formatos diferentes de backend.
- Recortar o histórico recente com `symposium.openai.maxHistoryMessages`.
- Continuar após um turn interrompido enquanto ferramentas estavam em execução.
- Restaurar um ledger que contém saída de ferramenta, mas não contém o envelope adjacente da chamada.

## O Que Fazer

Normalmente, nenhuma ação é necessária. O aviso é diagnóstico e a requisição continua.

Se o modelo parecer confuso depois do aviso:

1. Peça ao agente para resumir o estado atual antes de continuar.
2. Aumente `symposium.openai.maxHistoryMessages` ou defina como `0` para enviar o histórico completo.
3. Inicie uma nova sessão quando o transcript antigo veio de outro backend ou sofreu muitas interrupções.

A garantia principal é que o folding afeta apenas a requisição enviada ao provedor. O transcript salvo permanece inalterado.
