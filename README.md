# vegas-mcp

Um servidor MCP que deixa o Claude editar um projeto aberto no **VEGAS Pro 2026** do seu computador. Você pede em texto, no Claude Desktop ou no Claude Code, e o Claude corta pausas e repetições, ajusta fades e normalização, acelera clipes, põe legendas e overlays, e renderiza o projeto.

Projeto independente e não oficial. Não tem afiliação com os fabricantes do VEGAS Pro. Licença MIT (ver `LICENSE`).

> **Estado:** testado só com o VEGAS Pro 2026.0.3 (build 189), no Windows 11. Outras versões do VEGAS não foram testadas.

## O que você precisa

- Windows 10 ou 11, com o **VEGAS Pro 2026** instalado e com a sua licença. Este projeto não inclui nem redistribui arquivos do VEGAS.
- Node.js 20 ou mais novo. O passo `deps` do instalador instala com o `winget` se faltar.
- Python 3.11, FFmpeg e o Whisper (transcrição local, na CPU). O instalador cuida disso.
- Claude Desktop, Claude Code ou os dois.

## Instalação

Abra o PowerShell na pasta do repositório:

```powershell
scripts\install.ps1 -Plan                      # mostra os passos e não muda nada
scripts\install.ps1 -Check                     # diagnóstico somente leitura
scripts\install.ps1 -Apply deps,whisper,build,bridge,desktop,code
```

Cada passo é idempotente e faz backup antes de alterar um arquivo:

| Passo | O que faz |
|---|---|
| `deps` | instala Node.js 20, Python 3.11 e FFmpeg com o `winget` (baixa software) |
| `whisper` | cria o ambiente Python em `%USERPROFILE%\.vegas-mcp\whisper-venv` e instala o faster-whisper |
| `build` | `npm ci` no projeto e no `remotion/`, depois `npm run build` |
| `bridge` | copia `vegas-bridge\Bridge.cs` para a pasta *Script Menu* do VEGAS |
| `desktop` | registra o servidor no `claude_desktop_config.json` do Claude Desktop |
| `code` | registra o servidor no `~/.claude.json` para esta pasta (Claude Code) |

Se a pasta do VEGAS estiver protegida, rode o PowerShell como administrador no passo `bridge`.

### Ligar a ponte no VEGAS

A API de script do VEGAS só responde dentro do próprio programa. Por isso a ponte é um script que roda dentro dele e escuta só em `127.0.0.1:47802`:

1. Abra o VEGAS Pro 2026 com o projeto que você quer editar.
2. Vá em **Tools > Scripting > Bridge**.
3. Deixe a janela de script aberta. Use `vegas_status` no Claude para confirmar que ela responde.

Depois de atualizar o repositório, rode o passo `bridge` de novo e reinicie a ponte no VEGAS, senão ele continua com a versão antiga.

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `vegas_status` | confere se a ponte responde e se o projeto tem alterações não salvas |
| `vegas_list_timeline` | lista trilhas e eventos da timeline, com posições e o arquivo de cada clipe |
| `transcribe_speech` | transcreve o áudio localmente com o Whisper, palavra por palavra |
| `list_audio_tracks` | lista as trilhas de áudio de um arquivo |
| `find_speech_cuts` | acha pausas, repetições, recomeços e silêncio para cortar |
| `vegas_plan_cuts` | prepara o plano de cortes, sem tocar no projeto |
| `vegas_apply_cuts` | aplica o plano. Exige o projeto salvo e cria um backup antes |
| `vegas_insert_overlay` | põe um `.mov` com alfa numa trilha acima dos clipes |
| `render_overlay` | renderiza um overlay animado com alfa (Remotion) |
| `vegas_add_captions` | queima as legendas do transcrito numa camada, com 7 estilos |
| `prepare_subtitles` | valida e ajusta um `.srt` |
| `vegas_audio_info` | lê fades, taxa de reprodução, mudo e normalização de um evento |
| `vegas_set_fades` | define o fade de entrada e de saída de um evento |
| `vegas_set_normalize` | liga ou desliga a normalização de um evento |
| `vegas_set_speed` | acelera um clipe de 1× a 10× e fecha o buraco que sobra |
| `vegas_motion_info` | lê se o clipe está em *scale to fill* e os cantos do keyframe |
| `vegas_set_scale_to_fill` | liga ou desliga *scale to fill* |
| `vegas_set_motion` | posiciona o clipe no quadro, com escala de até 1 e deslocamento em pixels. **Experimental**: zoom para dentro não aparece no render, e algumas posições saíram pretas |
| `vegas_list_markers` | lista os marcadores da timeline, com posição e texto |
| `vegas_add_marker` | adiciona um marcador com texto numa posição em ms. Não muda a imagem nem o som |
| `vegas_remove_marker` | remove um marcador pelo índice que `vegas_list_markers` mostra |
| `vegas_list_render_templates` | lista os modelos de render instalados no VEGAS |
| `vegas_render` | renderiza o projeto e confere duração, imagem e som do arquivo |
| `preview_sheet` | monta uma folha de contato com quadros espaçados de um vídeo |

Exemplos de pedido: "confere se o VEGAS está respondendo", "transcreve o clipe e corta as pausas maiores que 0,7 segundo", "acelera a primeira parte para 2 vezes", "põe legendas no estilo karaokê", "renderiza em 720p e me mostra uma folha de contato".

## Segurança e desfazer

- A ponte só escuta no seu computador, e cada pedido precisa do token em `%APPDATA%\vegas-mcp\bridge-token.txt`.
- Cada operação que muda o projeto roda num bloco de desfazer do VEGAS. Um **Ctrl+Z** reverte a operação inteira. Testado para velocidade, corte, remoção e legenda.
- O render nunca sobrescreve um arquivo existente.
- Nenhum arquivo de mídia é alterado. Os renders e as legendas ficam em `out\` dentro do repositório.
- `vegas_apply_cuts` recusa um projeto com alterações não salvas, e faz backup do `.veg` antes.

## Limites conhecidos

- **Velocidade só para acelerar** (1× a 10×). Para voltar ao normal, use Ctrl+Z.
- **Ao acelerar ou cortar, as trilhas depois do clipe andam para trás** em todas as trilhas, como um *ripple*. Se houver música ou legenda depois do clipe, elas também se movem.
- **Legendas são um overlay**, não eventos de legenda do VEGAS, porque a API de script não importa legendas.
- **Um render saiu preto e mudo uma vez**, sem causa encontrada. O `vegas_render` avisa quando isso acontece. Confira o arquivo antes de entregar.
- **O áudio do render chega cerca de 100 ms depois** do áudio do arquivo original decodificado. Medido, ainda não corrigido.
- **Movimento:** o zoom para dentro (escala acima de 1) não aparece no render. Algumas posições renderizam preto e mudo, sem regra conhecida. Confira o resultado com `vegas_render` antes de entregar.
- **Transcrição na CPU**, com o modelo `small`. Clipes longos levam minutos.

Detalhes medidos no VEGAS, com o método de cada medição, estão em [docs/vegas-api.md](docs/vegas-api.md).

## Desinstalar

Ainda não há script de desinstalação. Para remover:

1. Apague a entrada `vegas-mcp` em `mcpServers` no `claude_desktop_config.json`.
2. Apague a entrada deste repositório em `~/.claude.json`.
3. Apague o `Bridge.cs` da pasta *Script Menu* do VEGAS.
4. Apague `%USERPROFILE%\.vegas-mcp` e `%APPDATA%\vegas-mcp`.
5. Apague a pasta do repositório.

## Para quem quer contribuir

```powershell
npm ci
npm run typecheck
npm test        # testes unitários, sem o VEGAS aberto
npm run build
```

Os testes que dependem do VEGAS e do render não rodam sem ele. O que foi medido ao vivo está registrado em `docs/vegas-api.md`.

## Créditos

- Os estilos de legenda se inspiram nos presets dos projetos mcp-cut e capcut-mcp (ambos MIT). O código aqui foi escrito do zero.
- A folha de contato se inspira na verificação de prévia do FCPXML MCP (MIT).
