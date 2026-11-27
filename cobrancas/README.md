# Robô de Cobrança – mensalidades de piscina pelo WhatsApp

App separado do cadastro do evento. Ele:

1. **Gera as mensalidades** de cada cliente automaticamente (valor e dia de vencimento do cadastro).
2. **Cria o link de pagamento no Asaas** (o cliente escolhe Pix, boleto ou cartão).
3. **Manda as mensagens de cobrança sozinho pelo seu WhatsApp** (robô), seguindo a régua:
   - 3 dias antes do vencimento
   - no dia do vencimento
   - 1, 5 e 10 dias de atraso
4. **Dá baixa automática** quando o cliente paga (webhook do Asaas e conferência a cada hora) e para de cobrar.

Tudo isso é configurável na tela **Configurações**: textos das mensagens, dias da régua, horário de envio, limite por dia.

## Como o robô funciona

O robô usa o **seu próprio número de WhatsApp**, conectado como "aparelho conectado" (igual ao WhatsApp Web):
na aba **Hoje**, clique em **Conectar** e leia o QR Code no celular em *WhatsApp → Aparelhos conectados → Conectar um aparelho*.

Depois disso ele envia **uma mensagem por vez**, com um intervalo aleatório entre elas (padrão: 45 a 120 segundos),
só dentro do horário configurado (padrão: 9h às 18h, sem domingos) e até um limite diário (padrão: 60).

Antes de cada envio ele confere no Asaas se o cliente já pagou, para não cobrar quem acabou de pagar.

Se o robô estiver desligado ou o WhatsApp desconectado, a aba **Hoje** mostra as mensagens do dia com um botão
**Enviar eu mesmo**, que abre o WhatsApp com a mensagem pronta.

> **Atenção:** esse tipo de conexão não é a API oficial do WhatsApp. Usar com moderação (só seus clientes, mensagens
> esperadas, intervalos entre envios) costuma funcionar bem, mas existe risco de o WhatsApp restringir o número se
> houver muitas denúncias ou envios em massa. Se preferir, use um número separado (WhatsApp Business num chip só para
> isso).

## Instalação

Precisa de **Node.js 20 ou mais novo**.

```bash
cd cobrancas
npm install
cp .env.example .env      # e edite o .env (veja abaixo)
npm run build
npm start                 # abre em http://localhost:3000
```

Para desenvolver: `npm run dev`. Testes: `npm test`.

### Arquivo `.env`

| Variável | O que é |
|---|---|
| `ADMIN_PASSWORD` | Senha para entrar no painel. **Obrigatória.** |
| `APP_URL` | Endereço público do app (ex.: `https://cobranca.seudominio.com.br`). |
| `ASAAS_API_KEY` | Chave de API do Asaas. **Sem ela o app roda em modo simulado** (links de teste). |
| `ASAAS_ENV` | `sandbox` para testar, `production` para cobrar de verdade. |
| `ASAAS_WEBHOOK_TOKEN` | Senha que você inventa e coloca também no webhook do Asaas. |
| `DATA_DIR` | (opcional) pasta onde ficam os dados. Padrão: `./data`. |

### Configurando o Asaas

1. Crie a conta em [asaas.com](https://www.asaas.com). Para testar antes, use o sandbox em
   [sandbox.asaas.com](https://sandbox.asaas.com) com `ASAAS_ENV="sandbox"`.
2. Em **Integrações → Chave de API**, gere a chave e coloque em `ASAAS_API_KEY`.
3. Cadastre uma **chave Pix** na conta do Asaas, para as cobranças aceitarem Pix.
4. Em **Integrações → Webhooks**, crie um webhook:
   - URL: `https://SEU-ENDERECO/api/webhooks/asaas`
   - Token de autenticação: o mesmo valor de `ASAAS_WEBHOOK_TOKEN`
   - Eventos: *Pagamento recebido*, *Pagamento confirmado*, *Pagamento removido* e *Pagamento estornado*

O app cria o cliente no Asaas com as **notificações do Asaas desligadas**, porque quem avisa o cliente é o robô.
As taxas por pagamento são as do seu plano no Asaas.

Sem webhook (por exemplo, rodando no seu computador), o app confere os pagamentos no Asaas a cada hora e
também logo antes de cada mensagem, então funciona do mesmo jeito, só com um pouco mais de atraso para dar baixa.

## Onde hospedar

O robô só envia enquanto o app está ligado, então ele precisa rodar num servidor 24 horas:
uma VPS simples (Hostinger, Contabo, DigitalOcean, Oracle Cloud grátis), Railway ou Render com **disco persistente**.
Os dados (clientes, cobranças e a sessão do WhatsApp) ficam na pasta `data/`. **Faça backup dela.**
Se essa pasta for perdida, será preciso ler o QR Code de novo.

## Uso do dia a dia

1. **Clientes → Novo cliente**: nome, WhatsApp, CPF/CNPJ (exigido pelo Asaas), valor mensal e dia de vencimento.
2. Pronto. A mensalidade é criada 7 dias antes do vencimento (configurável) e o robô cuida das mensagens.
3. Recebeu em dinheiro ou Pix direto? Em **Cobranças**, use **Marcar paga** (dá baixa no Asaas também).
4. Serviço extra (troca de areia, conserto)? **Cobranças → Cobrança avulsa**. Entra na mesma régua.
5. Cliente parou o serviço? Edite e desmarque **Cliente ativo**. Para de gerar mensalidades e de mandar mensagens.

## Estrutura

```
server/
  index.ts      rotas da API, login, webhook e rotina de hora em hora
  billing.ts    geração de mensalidades, régua de cobrança, sincronização com o gateway
  robot.ts      robô de envio (janela de horário, intervalo, limite diário)
  whatsapp.ts   conexão com o WhatsApp via QR Code (biblioteca Baileys)
  gateway.ts    integração com o Asaas + modo simulado
  db.ts         armazenamento em arquivo JSON
shared/         tipos e funções usadas no servidor e na tela
src/            telas (React + Tailwind)
```
