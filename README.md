# Sala ao Vivo

Salas de conversa no navegador com **chat de texto**, **voz** e **compartilhamento de tela**, sem instalar nada.

- **Front-end:** HTML, CSS e JavaScript puro
- **Back-end:** Python + FastAPI (WebSocket)
- **Mídia:** WebRTC P2P — voz e tela vão direto de um navegador para o outro

## Como funciona

```
Navegador A ──WebSocket──┐            ┌──WebSocket── Navegador B
                         ▼            ▼
                    Servidor FastAPI (sinalização + chat)

Navegador A ◄════════ WebRTC (voz e tela, P2P) ════════► Navegador B
```

O servidor só apresenta os participantes, repassa as mensagens de negociação
WebRTC (offer/answer/ICE) e distribui o chat. Áudio e vídeo nunca passam por ele.

Cada participante abre uma conexão com cada outro (malha), por isso a sala tem
limite de 8 pessoas. A negociação segue o padrão *perfect negotiation*, então
qualquer um pode ligar o microfone ou começar a compartilhar a tela a qualquer
momento sem conflito de ofertas.

## Rodando

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn server.main:app --port 5182 --reload
```

Abra http://localhost:5182, digite seu nome e clique em **Entrar** para criar
uma sala. Use **Convidar** para copiar o link e abra em outra aba ou navegador.

## Limitações atuais

- **Só funciona em `localhost`.** Navegadores só liberam microfone e captura de
  tela em HTTPS ou localhost. Para usar na rede ou na internet é preciso HTTPS
  (deploy ou certificado) e, atrás de roteadores mais restritivos, um servidor TURN.
- Salas e histórico do chat ficam em memória e somem quando o servidor reinicia.
- Sem login: qualquer pessoa com o código entra na sala.
