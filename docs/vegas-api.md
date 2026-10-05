# VEGAS Pro scripting: o que foi medido

Registro do que foi testado de verdade no VEGAS Pro **2026.0.3 (build 189)**, em um projeto de teste. Cada item diz como foi medido. Se um item não tem medição, ele não está aqui.

Fontes de referência, todas locais na instalação:
- `ScriptPortal.Vegas.dll` e `ScriptPortal.Vegas.xml` em `C:\Program Files\BorisFX\Vegas Pro 2026`.
- Exemplos em `Script Menu`, em particular `Repair and Smooth.cs`.

## Tempo e posições

- **Timecode aceita milissegundos** em `new Timecode(double)`. Medido: `split` em 10000 ms cortou a 10 s da timeline.
- **`TrackEvent.Split(Timecode)` recebe o deslocamento a partir do início do evento**, não a posição absoluta. Medido: split com `offset = 10000` em um evento que começa em 20000 ms cortou em 30000 ms.
- **`TrackEvent.Start` tem setter.** Medido: a remoção com ripple moveu eventos com `ev.Start = new Timecode(...)`.
- **Os tempos aparecem com uma casa decimal** (`84583.3`). Medido: pela leitura da timeline. Cortes em posições não alinhadas a frame são aceitos, mas o VEGAS trabalha por frame.

## Eventos agrupados (vídeo + áudio)

- **Um grupo guarda todas as peças do clipe original**, não só a peça que foi cortada. Medido: `ev.Group` tinha quatro membros depois de dois cortes. Dividir por índice atingiu peças erradas e criou cortes em 5 s e 15 s que não foram pedidos. A correção: pegar a lista de membros e dividir só os que contêm a posição.
- **Os dois lados de um corte continuam agrupados.** Medido: `grouped: true` nas duas trilhas depois de remoção e split.
- **`TrackEvents.Remove(ev)`** existe (herdado de `BaseList<T>`) e remove o evento da trilha. Medido: a remoção de 20 s a 25 s retirou dois eventos.

## Takes e mídia

- **`TrackEvent.ActiveTake.Offset`** é o tempo de mídia que toca no início do evento. Medido: depois de cortar 5 s, a peça que começa em 5 s tem offset de 5 s, e a seguinte 10 s, nos dois lados.
- **`Take.MediaPath`** dá o caminho do arquivo de origem. Medido: `%USERPROFILE%\Downloads\d4c6fe15.mp4`.
- **`Media.HasVideo()` é método**, não propriedade. Medido: erro de compilação com a forma de propriedade.
- **O clipe de teste tinha áudio 2,2 s mais curto que o vídeo** (84583,3 ms contra 82384,4 ms). Medido no probe e confirmado depois dos cortes. A diferença é da origem, não dos cortes.

## Projeto

- **`Project.FilePath`** aponta para o `.veg` salvo. Medido: `%USERPROFILE%\OneDrive\Desktop\Untitled.veg` depois de salvar uma vez. Antes de salvar, o projeto não tem caminho.
- **`Project.IsModified`** fica `false` logo após salvar e `true` depois de editar. Medido: o status mostrou `false` depois do save.
- **Um `Ctrl+Z` desfez mais que a última remoção.** Medido: depois de um split e de uma remoção, um único Ctrl+Z voltou a timeline ao clipe original. A granularidade do `UndoBlock` ainda não está clara; testar antes de prometer "um passo por operação".

## Threads e interface

- **Os objetos COM só funcionam na thread que roda o script.** Medido: acesso a partir do thread de um listener gerou `InvalidCastException` (`IProjectCOM`).
- **Um laço com `Application.DoEvents()` deixou a interface do VEGAS sem resposta.** Relatado pelo usuário e confirmado: os cliques só voltaram depois de parar a bridge. Não usar laço bloqueante.
- **Um `System.Windows.Forms.Timer` criado no thread do script** processa os pedidos sem travar o VEGAS. Medido: `status`, `timeline`, `split`, `remove` e `backup` respondem com a interface liberada.

## Render

- **Renderizar a camada de legenda** (Remotion, separado do VEGAS): 10 s de camada levaram 43,6 s. Medido. Estimativa para 80 s: cerca de 6 minutos, a ser confirmada.

## Não existe na API

- **Importar legenda (SRT ou evento de legenda):** nenhuma classe ou método de legenda aparece no XML de documentação. Medido por busca no XML. O caminho usado é overlay.
- **Speech to Text nativo:** sem API de script no XML. Não usado.
- **Parâmetros de texto de geradores:** não verificado no 2026. Só há relato antigo de fórum.

## Ainda não medido

- `Project.Render(path, template)` com um template real: a listagem e o render estão implementados, mas não foram executados ao vivo.
- `AddVideoEvent` e `AddTake` para um overlay: implementados, compilam, ainda não rodaram.
- Qualquer efeito, transição, velocidade, fade, normalização e marcador: só existem no XML.

## Áudio (medido no render)

- **Fade de entrada e de saída funcionam no render.** `TrackEvent.FadeIn.Length` e `FadeOut.Length` aparecem na mídia renderizada como rampas: entrada de 1 s, de silêncio a 0,1 s até o nível normal perto de 1 s; saída de 1 s, de 19,0 s até quase zero em 19,9 s. Medido por janelas de 50 ms contra o original, com o atraso do render compensado.
- **Normalização funciona, mas o pico pode passar de 1,0.** `AudioEvent.Normalize = true` com `RecalculateNorm()` deu ganho de 1,237. O render escalou o pico pelo mesmo fator (0,8165 para 1,0112 nos dois canais), então o pico encosta em 1,0 e pode cortar um pouco.
- **Fade e normalização no mesmo evento renderizam em silêncio.** Reproduzido duas vezes. Com só um dos dois, o áudio sai normal. As tools recusam a combinação antes de tocar no VEGAS.
- **O render sai cerca de 3,3 dB acima do arquivo original**, sem nenhuma mudança minha no volume. Não confirmei a causa. A API tem `AudioTrack.Volume`, ainda não lido pela bridge. Vale conferir o fader da trilha de áudio no VEGAS.
- **O áudio do render chega cerca de 90 ms depois do áudio do original decodificado pelo ffmpeg.** Os dois streams começam em 0 no arquivo, e o deslocamento está no conteúdo. Pode ser diferença de decodificação do atraso inicial do AAC, e não um erro do render. Não confirmado com imagem.
- **Houve dois renders mudos antes de qualquer mudança de áudio** (16:28 e 16:44). Não reproduzidos no estado atual, que renderiza com som. Causa desconhecida.
