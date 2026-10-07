# Gabriel — carteira financeira

Aplicação local para acompanhar saldos e uma carteira pessoal de ações, FIIs e
criptoativos. A interface fica organizada em `index.html` (estrutura),
`styles.css` (visual) e `app.js` (interações). A interface não envia credenciais
ao navegador: chaves de provedores ficam no servidor local e chamadas de
mercado passam por ele. A senha da conta local é usada somente no navegador
para derivar a chave de criptografia.

Ao selecionar um ativo, a carteira busca o preço unitário disponível. Esse valor
preenche o formulário de compra e pode ser ajustado para refletir o preço
realmente pago. A quantidade e o preço unitário definem o total da operação; a
carteira mantém o preço médio e o total investido por posição. Compras e retiradas
registradas aqui são apenas controle pessoal e não enviam ordens à corretora.
Ao registrar uma venda, informe quantidade e preço por unidade; o valor bruto
informado é lançado como entrada no saldo da moeda do ativo e a posição é
reduzida pelo número de unidades vendidas.

A Visão geral inclui um resumo de mercado dos ativos cadastrados, com a variação
diária fornecida pelo provedor, o desempenho em relação ao preço médio e o
horário da cotação. Os ativos são consultados ao abrir o app e, enquanto ele
estiver aberto, a cada 60 segundos. Para o câmbio, o app usa primeiro a API
gratuita Frankfurter, sem chave; se ela estiver indisponível, tenta a brapi.dev
quando há token configurado. Ambas fornecem uma referência diária, não uma
cotação intradiária em tempo real.

Os cartões de USD/BRL, EUR/BRL, valorização do real frente ao dólar e ativos da
carteira abrem gráficos históricos diários para 1 mês, 3 meses ou 1 ano. O real é
representado pela quantidade de dólares que R$ 1 compra; aumento dessa série
significa valorização frente ao dólar. Os gráficos de câmbio usam o Frankfurter;
ações e FIIs da B3 usam a brapi.dev, e ativos internacionais/cripto usam candles
do Finnhub. Histórico pode estar indisponível conforme cobertura e plano do
provedor; a interface sinaliza a falha em vez de estimar dados.

O gráfico “Evolução da carteira” soma os saldos em dinheiro convertidos para
reais ao valor atual dos investimentos e guarda um ponto diário na conta local
criptografada quando todos os saldos e cotações estão disponíveis. As janelas
de 7 dias, 1 mês, 3 meses e 1 ano mostram somente observações coletadas enquanto
o app foi usado; o histórico começa na primeira avaliação completa e não
reconstrói valores de antes dessa data. A observação do dia é atualizada quando
o patrimônio muda ou as cotações são atualizadas.

## Executar

1. No terminal aberto nesta pasta, execute `cp .env.example .env`.
2. Configure somente as chaves de mercado que você for usar em `.env`; não as
   compartilhe nem as coloque no HTML.
3. Inicie com `python3 server.py` e abra <http://127.0.0.1:8000>.

## Contas locais

- Crie uma conta com nome, e-mail e senha. O e-mail serve como identificador
  local; o app não envia confirmação nem verifica se a caixa postal existe.
- A carteira de cada conta é criptografada no navegador com AES-GCM. A senha
  deriva a chave com PBKDF2/SHA-256 e não é armazenada. Ao sair, é necessário
  fazer login novamente.
- Dados não saem deste navegador e não sincronizam com outros dispositivos.
  Use cópias de segurança do perfil/navegador para evitar perda dos dados.
- Senha esquecida não pode ser redefinida: sem ela, não há como descriptografar
  a carteira. Guarde-a com segurança.
- A primeira conta criada importa os dados legados do app neste navegador.
- Isto é uma trava local para uso pessoal, não autenticação de servidor. Quem
  tem acesso à sua sessão do computador ou às ferramentas de desenvolvedor pode
  contornar o login; não publique esta configuração como site multiusuário.

## Acesso público e Open Finance

Esta versão está preparada para uso local, não para publicar como serviço com
contas remotas. Um site público exige autenticação de servidor, banco de dados,
HTTPS, isolamento de dados por usuário, gestão de sessões, proteção contra
abuso, política de privacidade e revisão legal/LGPD. Open Finance também não
está conectado; requer um iniciador/provedor autorizado e consentimento
bancário. Nunca solicite nem armazene senha bancária.

## Fontes e limites

- **Finnhub:** busca/cotações de ações internacionais e candles diários de ações
  e cripto. A cotação de ações dos EUA, mercados internacionais e dados
  históricos dependem da cobertura e do plano da conta Finnhub; alguns endpoints
  são Premium ou Enterprise.
- **brapi.dev:** busca/cotação de ações e FIIs da B3, proventos e PTAX de moedas.
  Cotações, câmbio e histórico de proventos dependem da cobertura e do plano da
  conta brapi.dev. A PTAX é uma referência diária do Banco Central, não uma
  cotação intradiária de mercado.
- **Frankfurter:** fonte gratuita de câmbio sem chave, consultada como principal
  para USD/BRL e EUR/BRL. Agrega taxas diárias de bancos centrais e fontes
  oficiais; os valores podem não acompanhar oscilações intradiárias. A brapi.dev
  é usada como alternativa quando a fonte gratuita não responde.
- A média mensal estimada soma os proventos em dinheiro dos últimos 12 meses por
  unidade e divide o total por 12, multiplicando pela quantidade em carteira.
  É uma média histórica, não uma promessa nem previsão de pagamento mensal.
  Amortizações de FIIs não são tratadas como dividendos.
- Criptoativos não têm dividendos; a carteira mostra o valor cotado, sem
  estimar recompensas de staking.
- A atualização é feita ao abrir/atualizar a carteira, com consulta automática
  a cada 60 segundos enquanto a página estiver aberta. Limites e atrasos do
  provedor continuam valendo.
- **Open Finance:** ainda não conectado. É necessária uma instituição ou
  iniciador/provedor autorizado, contrato e configuração de consentimento
  bancário, redirecionamento seguro, escopos e revogação. Nunca peça nem
  armazene senha bancária. A integração deve ser adicionada após escolher e
  validar um provedor compatível e os requisitos legais/LGPD.

Se a cotação autenticada da B3 não estiver disponível, a busca pode fornecer um
preço público de referência, identificado como tal e não como execução de ordem.
Se não houver preço, a tela informa o erro e permite digitar o valor realmente
pago. Para outros dados indisponíveis, a tela mostra o erro em vez de inventar
uma cotação.
