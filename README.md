# Octógono

**Sumô eletrônico com dois botões e nenhuma desculpa.**

Jogo de arena multiplayer em tempo real, 2 a 4 jogadores, visto de cima. Você
controla um disco dentro de um octógono. Não há vida, não há dano: você perde
quando é empurrado para fora. A arena encolhe ao longo da partida.

Duas ações com cooldown: **Empurrar** e **Refletir**. Refletir na hora certa
devolve o empurrão com juros; na hora errada te deixa meio segundo parado, perto
de uma borda que está encolhendo. O confronto é leitura mútua — em 200 ms.

---

## Rodar

Requer Node 22+.

```bash
npm install
```

### 1. O protótipo local (comece por aqui)

O arquivo mais importante do projeto. Quatro discos, um teclado, sem rede.
Abra direto no navegador — não precisa de build nem servidor:

```bash
# abra prototype/local.html no navegador (file://), ou:
npx serve prototype   # e acesse /local.html
```

Controles (até 4 jogadores no mesmo teclado):

| Jogador | Mover | Empurrar | Refletir |
|---|---|---|---|
| Amarelo | `WASD` | `Espaço` | `Shift` esq. |
| Verde | Setas | `/` | `Shift` dir. |
| Rosa | `IJKL` | `U` | `O` |
| Roxo | `TFGH` | `R` | `Y` |

### 2. Cliente + servidor (dev)

Dois terminais:

```bash
npm run dev:server   # servidor autoritativo em :8787
npm run dev:client   # cliente Vite em :5173
```

Abra `http://localhost:5173`, crie uma sala, e abra o link em outra aba/dispositivo.
Para simular latência (útil para testar predição): `http://localhost:5173/?lat=120`.

### 3. Produção (serviço único)

O servidor também serve o cliente compilado, então tudo roda numa porta só:

```bash
npm run build              # gera client/dist
npm start                  # servidor serve dist + WebSocket em :8787
```

Ou via Docker / Fly.io:

```bash
docker build -t octogono . && docker run -p 8787:8787 octogono
# ou
fly launch   # usa o Dockerfile e o fly.toml (WebSocket no free tier)
```

### Testes e checagem de tipos

```bash
npm test         # física determinística (17 asserções)
npm run typecheck
```

---

## Ajuste (o coração do jogo)

Todos os números de gameplay estão em **um único objeto** `TUNING`, em
[`shared/tuning.ts`](shared/tuning.ts) (e espelhado no protótipo). Mexa lá; o
jogo inteiro reage. O passo 2 da ordem de implementação — ajustar até a colisão
ter peso e o reflect ser uma aposta tensa — não é polimento, é onde o jogo nasce.

A pergunta em aberto: **o cooldown de Refletir (1600 ms) é longo o bastante para
que empurrar valha a pena?** Se todo mundo só reflete, aumente. Se ninguém
reflete, reduza. Só o playtest diz.

---

## Estrutura

```
shared/          código determinístico, importado por cliente E servidor
  tuning.ts        o objeto TUNING (a única fonte dos números)
  physics.ts       step() — a simulação inteira, uma função pura
  octagon.ts       geometria: dentro/fora, perímetro, vértices
  math.ts          Vec2 e helpers
  types.ts         Disc, SimState, InputCmd, ...
  protocol.ts      mensagens do fio (cliente <-> servidor)
  nickname.ts      sanitização e de-duplicação de apelidos
server/src/
  index.ts         WebSocket, salas, códigos, rate limit, serve o cliente
  room.ts          uma sala: jogadores, simulação autoritativa, fases
  loop.ts          o relógio global: tick 60Hz, snapshot 20Hz, faxina
client/src/
  main.ts          fluxo de telas + game loop + bomba de input a 60Hz
  net.ts           socket, predição, reconciliação, interpolação
  render.ts        canvas: arena, discos, efeitos, HUD
  input.ts         teclado + joystick virtual + dois botões
  effects.ts       hitstop, anéis, queda, flash do reflect
prototype/
  local.html       arquivo único, 4 discos, 1 teclado, sem rede
```

---

## Netcode, em uma casca de noz

Servidor autoritativo com predição e reconciliação (PRD §6.3):

- O servidor simula a **60Hz** — é a única verdade — e envia snapshots a **20Hz**.
- O cliente envia inputs a 60Hz, cada um com um `sequenceNumber`.
- **Predição:** o disco do próprio jogador aplica o input na hora e é
  re-simulado por cima da posição autoritativa a cada snapshot. Latência some
  para o seu disco (testado: trajetória a 120 ms de lag é idêntica à sem lag).
- **Interpolação:** os outros discos são renderizados ~100 ms no passado, entre
  os dois últimos snapshots. Nunca extrapolamos.
- **Determinismo:** a mesmíssima `step()` de `shared/physics.ts` roda nos dois
  lados. Sem `Math.random()`, sem `Date.now()` na simulação.

---

## Estado dos critérios de aceitação (PRD §10)

| # | Critério | Estado |
|---|---|---|
| 1 | Protótipo local jogável (4 discos, 1 teclado) | ✅ `prototype/local.html` |
| 2 | Partida completa entre dispositivos sem dessincronizar | ✅ testado (2 clientes) |
| 3 | A 120 ms de latência, disco próprio imediato e sem borracha | ✅ testado (trajetória ≡ sem lag) |
| 4 | Reflect certeiro inequivocamente legível | ✅ flash + hitstop + devolução |
| 5 | Rodada nunca passa de 60 s | ✅ `maxDuration` + arena encolhendo |
| 6 | 60 fps em celular de gama média | ⚙️ canvas leve (~6 formas); validar em campo |
| 7 | Ninguém vence só apertando Refletir | ⚙️ questão de balanceamento — playtest |

Os itens ⚙️ dependem de jogar de verdade, exatamente como o PRD manda.

---

## Fora do escopo da v1

Contas, progressão, cosméticos, ranking, times, power-ups, matchmaking público.
Se o jogo ficar raso depois de 20 partidas, um único item no centro quando a
arena está pequena resolveria — e só isso.
