# Hall da Fama — modo GRATUITO (igual ideia do Bop-It)

## Como funciona (sem Cloud Functions pagas)

| Peça | Função |
|------|--------|
| `/players/{nome}` | Recordes individuais de cada jogador |
| `/meta/leaderboard` | Fotografia consolidada (Top 10 easy / hard / boss) |
| Regras do Firestore | `create` na 1ª vez; `update` só após **24 horas** |
| Cliente (`main.js`) | Ao gravar uma pontuação válida, tenta criar ou renovar o snapshot |

**Não precisa** de plano Blaze nem de funções agendadas às 07h30.

Fluxo:
1. Jogador faz uma pontuação > 0 → grava em `/players`
2. O jogo tenta escrever em `meta/leaderboard`
   - Se **não existe** → **cria** o 1º ciclo (regras `allow create`)
   - Se **existe** e já passaram 24h → **atualiza** (regras `allow update`)
   - Se ainda está dentro das 24h → Firestore recusa (`permission-denied`) e o Hall **mantém** o ranking anterior

## O que publicar

Só o site (GitHub Pages) + regras no Firebase Console (ou `firebase deploy --only firestore:rules` se quiser).

A pasta `functions/` é **opcional** (versão paga com job às 07h30). No modo gratuito você pode ignorá-la.

## Checklist Firebase (Spark / gratuito)

1. Projeto **cyber-tech-game**
2. Authentication → **Anônimo** ativado
3. Firestore criado
4. Regras = conteúdo de `firestore.rules` (já no ZIP)
5. Subir o `index.html` + `assets/` para o GitHub Pages

Não é obrigatório rodar `firebase deploy --only functions`.

## Teste rápido

1. Crie um nome e faça uma pontuação > 0
2. No Console → Firestore → deve aparecer `meta/leaderboard`
3. Abra o Hall da Fama no jogo
4. Uma segunda pontuação **no mesmo dia** atualiza o jogador em `/players`, mas o **ranking consolidado** só muda depois de 24h (ou se alguém “renovar” quando a regra permitir)

