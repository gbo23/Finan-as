      (() => {
        const rates = { BRL: 1, USD: null, EUR: null };
        const symbols = { BRL: "R$", USD: "$", EUR: "€" };
        const currencyNames = { BRL: "Real brasileiro", USD: "Dólar americano", EUR: "Euro" };
        const initialState = {
          balances: { BRL: 0, USD: 0, EUR: 0 },
          transactions: []
        };
        let state;
        try {
          const saved = JSON.parse(localStorage.getItem("nua-wallet"));
          state = saved && saved.balances && saved.transactions ? saved : initialState;
        } catch {
          state = initialState;
        }
        let activeAction = "add";
        let hidden = false;
        let toastTimer;
        let holdings = [];
        let portfolioHistory = [];
        let portfolioHistoryPeriod = "7d";
        let marketQuotes = {};
        let exchangeQuotes = {};
        let exchangeError = "";
        let realPerformance = null;
        let realPerformanceError = "";
        let realPerformanceLoading = false;
        let realPerformanceUpdatedAt = 0;
        let selectedHistory = null;
        let historyPeriod = "1mo";
        let historyRequestId = 0;
        let authUser = null;
        let authMode = "login";
        let saveTimer = null;
        let persistQueue = Promise.resolve();
        let selectedAsset = null;
        let tradeMode = "buy";
        let searchMarket = "br";
        let searchTimer = null;
        let searchController = null;
        let refreshingPortfolio = false;
        let refreshIntervalsStarted = false;
        let activeKey = null;
        let lastLocalSnapshot = "";
        const accountStoreKey = "nua-local-accounts";
        const $ = (selector) => document.querySelector(selector);
        const setAuthMessage = (message, isError = false) => {
          const node = $("#auth-message");
          node.textContent = message;
          node.classList.toggle("error", isError);
        };
        const setAuthMode = (mode) => {
          authMode = mode;
          const signup = mode === "signup";
          $("#auth-title").textContent = signup ? "Crie seu espaço financeiro." : "Suas finanças, com você.";
          $("#auth-name-field").hidden = !signup;
          $("#auth-name").required = signup;
          $("#auth-password").autocomplete = signup ? "new-password" : "current-password";
          $("#auth-submit").textContent = signup ? "Criar conta" : "Entrar";
          $("#login-tab").classList.toggle("active", !signup);
          $("#signup-tab").classList.toggle("active", signup);
          $("#login-tab").setAttribute("aria-selected", String(!signup));
          $("#signup-tab").setAttribute("aria-selected", String(signup));
          setAuthMessage("");
        };
        const initializeAuth = async () => {
          $("#auth-screen").hidden = false;
          $("#main-app").hidden = true;
          if (!crypto?.subtle) {
            $("#auth-submit").disabled = true;
            setAuthMessage("Seu navegador não oferece criptografia segura. Acesse pelo servidor local em http://127.0.0.1:8000.", true);
            return;
          }
          try {
            loadAccounts();
          } catch (error) {
            $("#auth-submit").disabled = true;
            setAuthMessage(error.message, true);
          }
        };
        try {
          const savedHoldings = JSON.parse(localStorage.getItem("nua-investments"));
          if (Array.isArray(savedHoldings)) {
            holdings = savedHoldings;
            for (const holding of holdings) {
              if (holding.lastQuote) marketQuotes[holding.symbol] = holding.lastQuote;
            }
          }
        } catch {
          holdings = [];
        }
        const accountSnapshot = () => JSON.stringify({ wallet: state, holdings, portfolioHistory });
        const loadAccounts = () => {
          const accounts = JSON.parse(localStorage.getItem(accountStoreKey) || "[]");
          if (!Array.isArray(accounts)) throw new Error("Os dados das contas locais estão inválidos.");
          return accounts;
        };
        const encodeBytes = (bytes) => {
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return btoa(binary);
        };
        const decodeBytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
        const deriveAccountKey = async (password, salt) => {
          const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
          return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
            material,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
          );
        };
        const encryptAccountSnapshot = async (snapshot, key) => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            new TextEncoder().encode(typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot))
          );
          return { iv: encodeBytes(iv), ciphertext: encodeBytes(new Uint8Array(encrypted)) };
        };
        const decryptAccountData = async (account, key) => {
          const data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: decodeBytes(account.iv) },
            key,
            decodeBytes(account.ciphertext)
          )));
          if (!data.wallet?.balances || !Array.isArray(data.wallet.transactions) || !Array.isArray(data.holdings)) {
            throw new Error("Dados da conta inválidos.");
          }
          data.portfolioHistory = normalizePortfolioHistory(data.portfolioHistory);
          return data;
        };
        const writeLocalAccount = async (snapshot, email, key) => {
          const encrypted = await encryptAccountSnapshot(snapshot, key);
          const accounts = loadAccounts();
          const account = accounts.find((item) => item.email === email);
          if (!account) throw new Error("Não foi possível localizar esta conta neste navegador.");
          account.iv = encrypted.iv;
          account.ciphertext = encrypted.ciphertext;
          localStorage.setItem(accountStoreKey, JSON.stringify(accounts));
          lastLocalSnapshot = JSON.stringify(snapshot);
        };
        const persistLocalData = (snapshot) => {
          if (!activeKey || !authUser || snapshot === lastLocalSnapshot) return;
          const email = authUser.email;
          const key = activeKey;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            persistQueue = persistQueue.then(() => {
              if (authUser?.email !== email || activeKey !== key) return;
              return writeLocalAccount(JSON.parse(snapshot), email, key);
            }).catch((error) => showToast(`Não foi possível salvar localmente: ${error.message}`));
          }, 250);
        };
        const enterLocalApp = (user, data, key) => {
          authUser = user;
          activeKey = key;
          state = data.wallet;
          holdings = data.holdings;
          portfolioHistory = normalizePortfolioHistory(data.portfolioHistory);
          marketQuotes = {};
          for (const holding of holdings) {
            if (holding.lastQuote) marketQuotes[holding.symbol] = holding.lastQuote;
          }
          lastLocalSnapshot = accountSnapshot();
          $("#user-brand-name").textContent = user.name;
          $("#greeting-name").textContent = user.name;
          $("#user-avatar").textContent = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
          $("#user-avatar").setAttribute("aria-label", `Perfil de ${user.name}`);
          $("#auth-screen").hidden = true;
          $("#main-app").hidden = false;
          $("#current-date").textContent = new Intl.DateTimeFormat("pt-BR", {
            weekday: "long", day: "2-digit", month: "long"
          }).format(new Date()).toLocaleUpperCase("pt-BR");
          render();
          loadApiStatus();
          loadExchangeRates();
          if (holdings.length) refreshPortfolio();
          if (!refreshIntervalsStarted) {
            refreshIntervalsStarted = true;
            setInterval(() => {
              if (authUser && holdings.length) refreshPortfolio();
            }, 60_000);
            setInterval(() => {
              if (authUser) loadExchangeRates();
            }, 5 * 60_000);
          }
        };
        const format = (amount, currency = "BRL") => new Intl.NumberFormat("pt-BR", {
          style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
        }).format(amount);
        const totalInReais = () => {
          let cashValue = 0;
          let complete = true;
          for (const [currency, amount] of Object.entries(state.balances)) {
            if (amount === 0) continue;
            const converted = convertToBrl(amount, currency);
            if (converted === null) complete = false;
            else cashValue += converted;
          }
          const portfolio = portfolioTotals();
          return {
            amount: cashValue + portfolio.marketValue,
            invested: portfolio.marketValue,
            complete: complete && portfolio.completeValue
          };
        };
        const localDateKey = (date) => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");
          return `${year}-${month}-${day}`;
        };
        const normalizePortfolioHistory = (history) => {
          if (!Array.isArray(history)) return [];
          const byDate = new Map();
          for (const point of history) {
            if (!point || typeof point.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)
              || !Number.isFinite(point.value) || point.value < 0) continue;
            byDate.set(point.date, { date: point.date, value: Math.round(point.value * 100) / 100 });
          }
          return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-366);
        };
        const recordPortfolioSnapshot = (total) => {
          if (!activeKey || !total.complete || !Number.isFinite(total.amount) || total.amount < 0) return;
          const date = localDateKey(new Date());
          const value = Math.round(total.amount * 100) / 100;
          const existing = portfolioHistory.find((point) => point.date === date);
          if (existing?.value === value) return;
          portfolioHistory = normalizePortfolioHistory([
            ...portfolioHistory.filter((point) => point.date !== date),
            { date, value }
          ]);
        };
        const renderPortfolioHistory = (total) => {
          const rangeDays = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
          const periodLabels = { "7d": "7 dias", "30d": "1 mês", "90d": "3 meses", "1y": "1 ano" };
          const days = rangeDays[portfolioHistoryPeriod];
          const endDate = new Date();
          endDate.setHours(12, 0, 0, 0);
          const startDate = new Date(endDate);
          startDate.setDate(startDate.getDate() - days + 1);
          const rangeStart = localDateKey(startDate);
          const rangeEnd = localDateKey(endDate);
          const points = portfolioHistory.filter((point) => point.date >= rangeStart && point.date <= rangeEnd);
          const chart = $("#portfolio-chart");
          const empty = $("#portfolio-chart-empty");
          const labels = $(".chart-labels");
          const note = $("#portfolio-chart-note");
          const status = $("#portfolio-chart-status");
          const hideChart = () => {
            chart.hidden = true;
            labels.hidden = true;
            empty.hidden = hidden;
            status.textContent = hidden ? "Oculta" : `${periodLabels[portfolioHistoryPeriod]} · sem registros`;
            note.textContent = hidden
              ? "A evolução está oculta enquanto os valores da carteira estão ocultos."
              : "Os pontos são registrados diariamente quando o patrimônio completo pode ser calculado.";
            empty.textContent = hidden
              ? ""
              : portfolioHistory.length
                ? `Sem registros neste período. Histórico disponível desde ${formatMarketTime(portfolioHistory[0].date)}.`
                : total.complete
                  ? "A carteira começa a registrar o histórico a partir de hoje."
                  : "Aguardando cotações completas para iniciar o histórico da carteira.";
            $("#portfolio-chart-area").setAttribute("d", "");
            $("#portfolio-chart-line").setAttribute("d", "");
            return;
          };
          if (hidden) return hideChart();
          if (!points.length) return hideChart();

          chart.hidden = false;
          labels.hidden = false;
          empty.hidden = true;
          const values = points.map((point) => point.value);
          let minimum = Math.min(...values);
          let maximum = Math.max(...values);
          if (minimum === maximum) {
            const padding = Math.max(Math.abs(maximum) * 0.02, 1);
            minimum -= padding;
            maximum += padding;
          } else {
            const padding = (maximum - minimum) * 0.12;
            minimum -= padding;
            maximum += padding;
          }
          const startTime = startDate.getTime();
          const endTime = endDate.getTime();
          const coordinates = points.map((point) => {
            const pointDate = new Date(`${point.date}T12:00:00`);
            const x = Math.max(0, Math.min(360, (pointDate.getTime() - startTime) / (endTime - startTime) * 360));
            const y = 98 - (point.value - minimum) / (maximum - minimum) * 88;
            return { x, y };
          });
          const line = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
          $("#portfolio-chart-line").setAttribute("d", line);
          $("#portfolio-chart-area").setAttribute(
            "d",
            points.length > 1 ? `${line} L${coordinates.at(-1).x.toFixed(2)} 110 L${coordinates[0].x.toFixed(2)} 110 Z` : ""
          );
          const last = coordinates.at(-1);
          $("#portfolio-chart-dot").setAttribute("cx", String(last.x));
          $("#portfolio-chart-dot").setAttribute("cy", String(last.y));
          $("#portfolio-chart-start").textContent = formatMarketTime(points[0].date);
          $("#portfolio-chart-end").textContent = formatMarketTime(points.at(-1).date);
          let changeLabel = "";
          if (points.length > 1 && points[0].value > 0) {
            const change = (points.at(-1).value / points[0].value - 1) * 100;
            changeLabel = ` · ${change >= 0 ? "+" : ""}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(change)}%`;
          }
          status.textContent = `${periodLabels[portfolioHistoryPeriod]} · ${points.length} ${points.length === 1 ? "registro" : "registros"}${changeLabel}`;
          note.textContent = "Patrimônio total em reais, registrado uma vez ao dia quando os valores estão disponíveis. Não há dados anteriores ao início do histórico.";
        };
        const save = () => persistLocalData(accountSnapshot());
        const render = () => {
          const total = totalInReais();
          recordPortfolioSnapshot(total);
          renderPortfolioHistory(total);
          const totalText = total.complete
            ? format(total.amount)
            : total.amount > 0
              ? `≥ ${format(total.amount)}`
              : "R$ —";
          $("#total-balance").textContent = hidden ? "••••••" : totalText;
          $("#insight-total").textContent = hidden ? "••••••" : totalText;
          $("#total-detail").textContent = holdings.length
            ? `${format(total.invested)} em investimentos${total.complete ? "" : " · valor conhecido"}`
            : total.complete ? "Patrimônio disponível" : "Cotação necessária para converter";
          document.querySelectorAll("[data-wallet-value]").forEach((node) => {
            const currency = node.dataset.walletValue;
            const amount = state.balances[currency];
            const convertedValue = currency === "BRL" ? null : convertToBrl(amount, currency);
            const converted = convertedValue === null ? "" : format(convertedValue);
            node.innerHTML = `${hidden ? "••••" : format(amount, currency)}<span class="currency-converted">${hidden || !converted ? "" : `≈ ${converted}`}</span>`;
          });
          renderTransactions();
          renderPortfolio();
          renderMarketOverview();
          save();
        };
        const renderTransactions = () => {
          const filter = $("#transaction-filter").value;
          const transactions = state.transactions.filter((item) => filter === "all" || item.type === filter);
          const list = $("#transactions");
          if (!transactions.length) {
            list.innerHTML = '<div class="empty-state">Nenhuma movimentação por aqui ainda.</div>';
            return;
          }
          list.innerHTML = transactions.slice(0, 6).map((item) => {
            const incoming = item.type === "income";
            return `<div class="transaction">
              <span class="transaction-icon ${item.type}" aria-hidden="true">${incoming
                ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14m6-6-6 6-6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</span>
              <span class="transaction-name">${escapeHtml(item.description)}<span class="transaction-date">${item.date} · ${currencyNames[item.currency]}</span></span>
              <span class="transaction-amount ${item.type}">${incoming ? "+" : "−"}${format(item.amount, item.currency)}</span>
            </div>`;
          }).join("");
        };
        const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
          "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[char]);
        const showToast = (message) => {
          const toast = $("#toast");
          toast.textContent = message;
          toast.classList.add("show");
          clearTimeout(toastTimer);
          toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
        };
        $("#login-tab").addEventListener("click", () => setAuthMode("login"));
        $("#signup-tab").addEventListener("click", () => setAuthMode("signup"));
        $("#auth-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = $("#auth-submit");
          button.disabled = true;
          setAuthMessage(authMode === "signup" ? "Criando sua conta..." : "Entrando...");
          const passwordField = $("#auth-password");
          const password = passwordField.value;
          try {
            const signup = authMode === "signup";
            const email = $("#auth-email").value.trim().toLowerCase();
            const accounts = loadAccounts();
            if (!email || !email.includes("@")) throw new Error("Informe um e-mail válido.");
            if (password.length < 8 || password.length > 128) throw new Error("A senha precisa ter entre 8 e 128 caracteres.");
            if (signup) {
              const name = $("#auth-name").value.trim();
              if (!name || name.length > 80) throw new Error("Informe seu nome (até 80 caracteres).");
              if (accounts.some((account) => account.email === email)) {
                throw new Error("Já existe uma conta local com este e-mail. Entre usando sua senha.");
              }
              const salt = crypto.getRandomValues(new Uint8Array(16));
              const key = await deriveAccountKey(password, salt);
              const walletData = accounts.length === 0
                ? { wallet: state, holdings }
                : { wallet: { balances: { BRL: 0, USD: 0, EUR: 0 }, transactions: [] }, holdings: [] };
              const encrypted = await encryptAccountSnapshot(walletData, key);
              accounts.push({
                email,
                name,
                salt: encodeBytes(salt),
                ...encrypted
              });
              localStorage.setItem(accountStoreKey, JSON.stringify(accounts));
              localStorage.removeItem("nua-wallet");
              localStorage.removeItem("nua-investments");
              enterLocalApp({ email, name }, walletData, key);
              return;
            }
            const account = accounts.find((item) => item.email === email);
            if (!account) {
              throw new Error("Não há uma conta local com este e-mail neste navegador. Contas criadas em outro navegador ou na versão anterior na nuvem não são reconhecidas aqui. Use “Criar conta” para configurar o acesso local.");
            }
            const key = await deriveAccountKey(password, decodeBytes(account.salt));
            const walletData = await decryptAccountData(account, key);
            enterLocalApp({ email: account.email, name: account.name }, walletData, key);
          } catch (error) {
            setAuthMessage(error.name === "OperationError" ? "E-mail ou senha incorretos." : error.message, true);
          } finally {
            passwordField.value = "";
            button.disabled = false;
          }
        });
        $("#signout-button").addEventListener("click", async () => {
          try {
            clearTimeout(saveTimer);
            if (authUser && activeKey) {
              await persistQueue;
              await writeLocalAccount(JSON.parse(accountSnapshot()), authUser.email, activeKey);
            }
          } catch (error) {
            showToast(`Não foi possível salvar antes de sair: ${error.message}`);
          } finally {
            activeKey = null;
            authUser = null;
            state = { balances: { BRL: 0, USD: 0, EUR: 0 }, transactions: [] };
            holdings = [];
            portfolioHistory = [];
            marketQuotes = {};
            lastLocalSnapshot = "";
            $("#main-app").hidden = true;
            $("#auth-screen").hidden = false;
            $("#auth-form").reset();
            setAuthMode("login");
            showToast("Você saiu da sua conta.");
          }
        });
        const convertToBrl = (amount, currency) => {
          if (!Number.isFinite(amount)) return null;
          const rate = rates[currency];
          return Number.isFinite(rate) ? amount * rate : null;
        };
        const formatMarketTime = (value) => {
          const numeric = typeof value === "number" || /^\d{10,13}$/.test(String(value)) ? Number(value) : null;
          const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
          const date = numeric === null
            ? new Date(dateOnly ? `${value}T12:00:00` : value)
            : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
          return Number.isNaN(date.getTime())
            ? "horário indisponível"
            : dateOnly
              ? date.toLocaleDateString("pt-BR", { dateStyle: "short" })
              : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
        };
        const portfolioTotals = () => holdings.reduce((totals, holding) => {
          const quote = marketQuotes[holding.symbol];
          const marketValue = quote && Number.isFinite(quote.price) ? quote.price * holding.quantity : null;
          const investedValue = Number.isFinite(holding.averagePrice) ? holding.averagePrice * holding.quantity : null;
          const marketValueBrl = marketValue === null ? null : convertToBrl(marketValue, quote.currency || holding.currency);
          const investedValueBrl = investedValue === null ? null : convertToBrl(investedValue, holding.currency);
          if (marketValueBrl === null) {
            totals.completeValue = false;
          } else {
            totals.marketValue += marketValueBrl;
          }
          if (investedValueBrl === null) {
            totals.completeInvested = false;
          } else {
            totals.invested += investedValueBrl;
          }
          if (marketValueBrl === null || investedValueBrl === null) {
            totals.completeResult = false;
          } else {
            totals.result += marketValueBrl - investedValueBrl;
          }
          if (!quote || !Number.isFinite(quote.price)) totals.completeValue = false;
          if (holding.market === "crypto") return totals;
          if (holding.market !== "br" && holding.market !== "us") return totals;
          totals.incomeEligible += 1;
          if (quote && Number.isFinite(quote.annualPerUnit)) {
            const annualIncome = convertToBrl(quote.annualPerUnit * holding.quantity, holding.currency);
            if (annualIncome === null) totals.completeIncome = false;
            else {
              totals.annualIncome += annualIncome;
              totals.incomeKnown += 1;
            }
          } else {
            totals.completeIncome = false;
          }
          return totals;
        }, { marketValue: 0, invested: 0, result: 0, annualIncome: 0, incomeKnown: 0, incomeEligible: 0, completeValue: true, completeInvested: true, completeResult: true, completeIncome: true });
        const formatHoldingNumber = (value) => new Intl.NumberFormat("pt-BR", {
          maximumFractionDigits: 6
        }).format(value);
        const marketLabel = (market, subType) => {
          if (market === "crypto") return "Cripto";
          if (market === "us") return "Internacional";
          return subType === "fii" ? "FII · B3" : "B3";
        };
        const renderPortfolio = () => {
          const totals = portfolioTotals();
          const monthlyIncome = totals.annualIncome / 12;
          const monthlyIncomeText = !totals.incomeEligible
            ? format(0)
            : totals.incomeKnown
              ? `${totals.completeIncome ? "" : "≥ "}${format(monthlyIncome)}`
              : "—";
          const monthlyIncomeDetail = !totals.incomeEligible
            ? "Sem ações ou FIIs com proventos na carteira"
            : totals.incomeKnown
              ? `${totals.completeIncome ? "Média histórica" : `Parcial · ${totals.incomeKnown}/${totals.incomeEligible} ativos`} · últimos 12 meses ÷ 12`
              : `Histórico indisponível · ${totals.incomeEligible} ${totals.incomeEligible === 1 ? "ativo" : "ativos"}`;
          $("#overview-monthly-income").textContent = hidden ? "••••••" : monthlyIncomeText;
          $("#overview-monthly-income-detail").textContent = monthlyIncomeDetail;
          $("#portfolio-market-value").textContent = holdings.length && !totals.completeValue
            ? totals.marketValue > 0 ? `≥ ${format(totals.marketValue)}` : "—"
            : format(totals.marketValue);
          $("#portfolio-invested").textContent = totals.completeInvested ? format(totals.invested) : totals.invested > 0 ? `≥ ${format(totals.invested)}` : "—";
          $("#portfolio-invested-detail").textContent = totals.completeInvested
            ? "Custo das posições cadastradas"
            : `Valor conhecido · ${holdings.filter((item) => Number.isFinite(item.averagePrice)).length} de ${holdings.length} ativos`;
          const resultNode = $("#portfolio-result");
          resultNode.textContent = totals.completeResult ? `${totals.result >= 0 ? "+" : "−"}${format(Math.abs(totals.result))}` : "Parcial";
          resultNode.classList.toggle("positive", totals.completeResult && totals.result >= 0);
          resultNode.classList.toggle("negative", totals.completeResult && totals.result < 0);
          const investedNode = $("#portfolio-result-percent");
          investedNode.textContent = totals.completeResult && totals.invested > 0
            ? `${new Intl.NumberFormat("pt-BR", { signDisplay: "always", maximumFractionDigits: 2 }).format(totals.result / totals.invested * 100)}% sobre o investido`
            : "Inclua preço médio e aguarde cotações";
          $("#portfolio-asset-count").textContent = `${holdings.length} ${holdings.length === 1 ? "ativo" : "ativos"}${totals.completeValue ? "" : " · valor conhecido"}`;
          $("#portfolio-income").textContent = !totals.incomeEligible
            ? format(0)
            : totals.incomeKnown
              ? `${totals.completeIncome ? "" : "≥ "}${format(monthlyIncome)}`
              : "—";
          $("#portfolio-income-detail").textContent = !totals.incomeEligible
            ? "Sem ações ou FIIs com proventos na carteira"
            : totals.incomeKnown
              ? `${totals.completeIncome ? "Média histórica" : `Parcial · ${totals.incomeKnown}/${totals.incomeEligible} ativos`} · últimos 12 meses ÷ 12`
              : `Histórico indisponível · ${totals.incomeEligible} ${totals.incomeEligible === 1 ? "ativo" : "ativos"}`;

          const filter = $("#holding-filter").value;
          const shown = holdings.filter((holding) => filter === "all" || holding.market === filter);
          const list = $("#holdings-list");
          if (!shown.length) {
            list.innerHTML = `<div class="portfolio-empty">${holdings.length ? "Nenhum ativo nesta categoria." : "Sua carteira ainda está vazia. Busque uma ação, FII ou criptoativo para começar."}</div>`;
            return;
          }
          const rows = shown.map((holding) => {
            const quote = marketQuotes[holding.symbol] || holding.lastQuote;
            const currency = quote?.currency || holding.currency;
            const currentValue = quote && Number.isFinite(quote.price) ? quote.price * holding.quantity : null;
            const totalPaid = Number.isFinite(holding.averagePrice) ? holding.averagePrice * holding.quantity : null;
            const perUnitIncome = quote?.annualPerUnit;
            const annualIncomeValue = Number.isFinite(perUnitIncome) ? perUnitIncome * holding.quantity : null;
            const annualIncomeBrl = Number.isFinite(perUnitIncome)
              ? convertToBrl(annualIncomeValue, holding.currency)
              : null;
            const monthlyIncomeBrl = annualIncomeBrl === null ? null : annualIncomeBrl / 12;
            const incomeLabel = holding.market === "crypto"
              ? "criptoativos não pagam dividendos"
              : annualIncomeBrl === null
                ? annualIncomeValue !== null ? `últimos 12 meses · ${currency}` : "últimos 12 meses · sem dados"
                : "estimativa · últimos 12 meses";
            const incomeDescription = holding.market === "crypto"
              ? "Criptoativos não pagam dividendos."
              : annualIncomeBrl === null
                ? quote?.dividendError || "Histórico de proventos dos últimos 12 meses indisponível. Verifique a configuração e o plano da API."
                : "Estimativa calculada com proventos recebidos nos últimos 12 meses.";
            const error = quote?.error;
            const initial = escapeHtml(holding.symbol.slice(0, 3));
            return `<div class="holding-row">
              <div class="holding-head">
                <div class="holding-asset"><span class="holding-logo">${initial}</span><span class="holding-name"><strong>${escapeHtml(holding.name)}</strong><small>${escapeHtml(holding.symbol)} · ${marketLabel(holding.market, holding.subType)}</small></span></div>
                <div class="holding-actions"><button class="holding-action" type="button" data-holding-action="buy" data-symbol="${escapeHtml(holding.symbol)}" aria-label="Adicionar unidades de ${escapeHtml(holding.symbol)}">+ Comprar</button><button class="holding-action" type="button" data-holding-action="sell" data-symbol="${escapeHtml(holding.symbol)}" aria-label="Registrar venda de ${escapeHtml(holding.symbol)}">Vender</button></div>
              </div>
              <div class="holding-metrics">
                <div class="holding-value">${formatHoldingNumber(holding.quantity)}<span class="holding-secondary">quantidade</span></div>
                <div class="holding-value">${Number.isFinite(holding.averagePrice) ? format(holding.averagePrice, holding.currency) : "Não informado"}<span class="holding-secondary">preço médio pago</span></div>
                <div class="holding-value">${totalPaid === null ? "—" : `<span class="holding-cost-summary">${format(totalPaid, holding.currency)}</span>`}<span class="holding-secondary">total investido</span></div>
                <div class="holding-value">${quote && Number.isFinite(quote.price) ? format(quote.price, currency) : `<span class="holding-price-error">${escapeHtml(error || "Sem cotação")}</span>`}<span class="holding-secondary">${quote?.updatedAt ? `Fonte: ${escapeHtml(quote.source || "provedor")} · ${formatMarketTime(quote.updatedAt)}${quote.warning ? " · cotação não atualizada" : ""}` : "preço atual"}</span></div>
                <div class="holding-value">${currentValue === null ? "—" : format(currentValue, currency)}<span class="holding-secondary">valor de mercado</span></div>
                <div class="holding-value holding-income holding-monthly-income">${holding.market === "crypto" ? "—" : monthlyIncomeBrl !== null ? format(monthlyIncomeBrl) : annualIncomeValue !== null ? "—" : "Indisponível"}<span class="holding-secondary" title="${escapeHtml(incomeDescription)}">${holding.market === "crypto" ? "sem dividendos" : monthlyIncomeBrl !== null ? "média mensal · últimos 12 meses" : "média mensal · sem histórico"}</span></div>
              </div>
            </div>`;
          }).join("");
          list.innerHTML = rows;
          list.querySelectorAll("[data-holding-action]").forEach((button) => {
            button.addEventListener("click", () => {
              const holding = holdings.find((item) => item.symbol === button.dataset.symbol);
              if (holding) openAssetModal(holding, button.dataset.holdingAction);
            });
          });
        };
        const renderMarketOverview = () => {
          const currencyCards = [
            { symbol: "USD", code: "USD / BRL", name: "Dólar em reais", unit: "BRL", rate: exchangeQuotes.USD },
            { symbol: "EUR", code: "EUR / BRL", name: "Euro em reais", unit: "BRL", rate: exchangeQuotes.EUR },
          ].map(({ symbol, code, name, unit, rate }) => `
            <button class="market-currency-card" type="button" data-history-market="currency" data-history-symbol="${symbol}" aria-label="Ver gráfico histórico de ${name}">
              <span class="market-currency-head"><span class="market-currency-symbol">${code}</span><span class="market-currency-change">Ver gráfico ↗</span></span>
              <span class="market-currency-name">${name}</span>
              <strong class="market-currency-value">${rate && Number.isFinite(rate.mid) ? format(rate.mid, unit) : "Indisponível"}</strong>
              <span class="market-currency-detail">${rate ? `${escapeHtml(rate.source || "Taxa diária")} · ${formatMarketTime(rate.updatedAt)} · clique para ver a variação` : escapeHtml(exchangeError || "Referência diária indisponível")}</span>
            </button>
          `);
          const realChange = realPerformance === null
            ? realPerformanceError || "Calculando valorização..."
            : `${realPerformance >= 0 ? "+" : ""}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(realPerformance)}% vs dólar · 1 mês`;
          const realChangeClass = realPerformance === null ? "" : realPerformance >= 0 ? "up" : "down";
          currencyCards.push(`
            <button class="market-currency-card" type="button" data-history-market="currency" data-history-symbol="BRL" aria-label="Ver gráfico da valorização do real contra o dólar">
              <span class="market-currency-head"><span class="market-currency-symbol">VALORIZAÇÃO DO REAL</span><span class="market-currency-change ${realChangeClass}">Ver gráfico ↗</span></span>
              <span class="market-currency-name">Poder de compra frente ao dólar</span>
              <strong class="market-currency-value">${Number.isFinite(rates.USD) && rates.USD > 0 ? `US$ ${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(1 / rates.USD)} / R$ 1` : "Indisponível"}</strong>
              <span class="market-currency-detail">${escapeHtml(realChange)} · Frankfurter, taxa diária</span>
            </button>
          `);
          $("#market-currency-list").innerHTML = currencyCards.join("");
          const list = $("#market-watch-list");
          if (!holdings.length) {
            list.innerHTML = '<div class="market-watch-empty">Sua carteira ainda não tem ativos para acompanhar.<br>Adicione ações, FIIs ou criptoativos na aba Investimentos.</div>';
            $("#market-overview-note").textContent = "Câmbio por Frankfurter com atualização diária. Ativos mostram candles diários conforme cobertura e plano do provedor. Clique em um cartão para abrir o gráfico.";
            return;
          }
          list.innerHTML = holdings.map((holding) => {
            const quote = marketQuotes[holding.symbol] || holding.lastQuote;
            const hasPrice = Number.isFinite(quote?.price);
            const dailyChange = Number.isFinite(quote?.changePercent) ? quote.changePercent : null;
            const positionChange = hasPrice && Number.isFinite(holding.averagePrice) && holding.averagePrice > 0
              ? (quote.price / holding.averagePrice - 1) * 100
              : null;
            const dailyClass = dailyChange === null ? "neutral" : dailyChange > 0 ? "up" : dailyChange < 0 ? "down" : "neutral";
            const positionClass = positionChange === null ? "" : positionChange > 0 ? "up" : positionChange < 0 ? "down" : "";
            const dailyValue = `${dailyChange > 0 ? "▲ " : dailyChange < 0 ? "▼ " : ""}${new Intl.NumberFormat("pt-BR", { signDisplay: "always", maximumFractionDigits: 2 }).format(dailyChange)}%`;
            const dailyLabel = dailyChange === null
              ? "variação do dia indisponível"
              : quote.warning ? `última variação ${dailyValue}` : dailyValue;
            const performance = positionChange === null
              ? "Preço atual ou preço médio indisponível"
              : `${positionChange >= 0 ? "+" : ""}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(positionChange)}% desde a compra${quote.warning ? " · cotação anterior" : ""}`;
            const detail = quote?.updatedAt
              ? `${quote.source || "Provedor"} · ${formatMarketTime(quote.updatedAt)}${quote.warning ? " · cotação anterior" : ""}`
              : quote?.error || "Aguardando cotação";
            return `<button class="market-watch-card" type="button" data-history-market="${escapeHtml(holding.market)}" data-history-symbol="${escapeHtml(holding.symbol)}" aria-label="Ver gráfico histórico de ${escapeHtml(holding.name)}">
              <div class="market-watch-top"><span class="market-watch-symbol">${escapeHtml(holding.symbol)}</span><span class="market-watch-change ${dailyClass}">${dailyLabel}</span></div>
              <div class="market-watch-name">${escapeHtml(holding.name)}</div>
              <strong class="market-watch-price">${hasPrice ? format(quote.price, quote.currency || holding.currency) : "Sem cotação"}</strong>
              <span class="market-watch-performance ${positionClass}">${performance}</span>
              <span class="market-watch-performance">${escapeHtml(detail)}</span>
            </button>`;
          }).join("");
          $("#market-overview-note").textContent = "Câmbio por Frankfurter com atualização diária. Gráficos de ações e criptoativos usam candles diários conforme cobertura e plano do provedor. Clique em um cartão para abrir o histórico.";
        };
        const loadRealPerformance = async () => {
          if (realPerformanceLoading || Date.now() - realPerformanceUpdatedAt < 15 * 60_000) return;
          realPerformanceLoading = true;
          try {
            const params = new URLSearchParams({ market: "currency", symbol: "BRL", period: "1mo" });
            const response = await fetch(`/api/market/history?${params}`);
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Histórico cambial indisponível.");
            const points = result.points || [];
            if (points.length < 2 || points[0].value <= 0) throw new Error("O provedor não retornou pontos suficientes.");
            realPerformance = (points[points.length - 1].value / points[0].value - 1) * 100;
            realPerformanceError = "";
            realPerformanceUpdatedAt = Date.now();
            renderMarketOverview();
          } catch (error) {
            realPerformanceError = `Valorização indisponível: ${error.message}`;
            realPerformanceUpdatedAt = Date.now();
            renderMarketOverview();
          } finally {
            realPerformanceLoading = false;
          }
        };
        const historyFormat = (value, data) => {
          if (data.metric === "appreciation") {
            return `US$ ${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value)} por R$ 1`;
          }
          if (["BRL", "USD", "EUR"].includes(data.unit)) return format(value, data.unit);
          return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 }).format(value);
        };
        const renderHistoryChart = (data) => {
          const points = data.points;
          const values = points.map((point) => point.value);
          const first = values[0];
          const last = values[values.length - 1];
          const change = first ? (last / first - 1) * 100 : 0;
          const plottedValues = data.metric === "appreciation"
            ? values.map((value) => (value / first - 1) * 100)
            : values;
          let minimum = Math.min(...plottedValues);
          let maximum = Math.max(...plottedValues);
          if (minimum === maximum) {
            const padding = Math.max(Math.abs(maximum) * 0.01, 0.01);
            minimum -= padding;
            maximum += padding;
          }
          const padding = (maximum - minimum) * 0.12;
          minimum -= padding;
          maximum += padding;
          const left = 42;
          const right = 704;
          const top = 24;
          const bottom = 216;
          const coordinates = plottedValues.map((value, index) => ({
            x: left + index / (plottedValues.length - 1) * (right - left),
            y: bottom - (value - minimum) / (maximum - minimum) * (bottom - top),
            value,
          }));
          const path = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
          $("#history-area").setAttribute("d", `${path} L${right} ${bottom} L${left} ${bottom} Z`);
          $("#history-line").setAttribute("d", path);
          const finalPoint = coordinates[coordinates.length - 1];
          $("#history-dot").setAttribute("cx", String(finalPoint.x));
          $("#history-dot").setAttribute("cy", String(finalPoint.y));
          const axisFormat = (value) => data.metric === "appreciation"
            ? `${value >= 0 ? "+" : ""}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value)}%`
            : historyFormat(value, data);
          $("#history-y-top").textContent = axisFormat(maximum);
          $("#history-y-mid").textContent = axisFormat((maximum + minimum) / 2);
          $("#history-y-bottom").textContent = axisFormat(minimum);
          $("#history-current-value").textContent = historyFormat(last, data);
          const changeNode = $("#history-change");
          changeNode.textContent = `${change >= 0 ? "+" : ""}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(change)}% no período`;
          changeNode.classList.toggle("up", change > 0);
          changeNode.classList.toggle("down", change < 0);
          $("#history-start-date").textContent = formatMarketTime(points[0].date);
          $("#history-end-date").textContent = formatMarketTime(points[points.length - 1].date);
          $("#history-source").textContent = `${data.source} · série histórica diária; para o real, o percentual positivo indica valorização frente ao dólar.`;
        };
        const loadMarketHistory = async (market, symbol, period = historyPeriod) => {
          selectedHistory = { market, symbol };
          historyPeriod = period;
          const requestId = ++historyRequestId;
          $("#history-backdrop").classList.add("open");
          $("#history-title").textContent = market === "currency"
            ? symbol === "BRL" ? "Valorização do real vs dólar" : `${symbol} / BRL`
            : `${symbol} · variação de mercado`;
          $("#history-description").textContent = "Consultando série histórica diária...";
          $("#history-current-value").textContent = "Carregando...";
          $("#history-change").textContent = "";
          $("#history-error").hidden = true;
          $("#history-chart-wrap").hidden = false;
          document.querySelectorAll("[data-history-period]").forEach((button) => {
            button.classList.toggle("active", button.dataset.historyPeriod === period);
            button.disabled = true;
          });
          try {
            const params = new URLSearchParams({ market, symbol, period });
            const response = await fetch(`/api/market/history?${params}`);
            const result = await response.json();
            if (requestId !== historyRequestId) return;
            if (!response.ok) throw new Error(result.error || "Não foi possível carregar o histórico.");
            if (!Array.isArray(result.points) || result.points.length < 2) {
              throw new Error("O provedor não retornou pontos suficientes para montar o gráfico.");
            }
            renderHistoryChart(result);
            $("#history-description").textContent = period === "1mo" ? "Último mês" : period === "3mo" ? "Últimos 3 meses" : "Último ano";
          } catch (error) {
            if (requestId !== historyRequestId) return;
            $("#history-chart-wrap").hidden = true;
            $("#history-error").textContent = error.message;
            $("#history-error").hidden = false;
            $("#history-description").textContent = "Histórico indisponível";
            $("#history-current-value").textContent = "—";
          } finally {
            if (requestId === historyRequestId) {
              document.querySelectorAll("[data-history-period]").forEach((button) => { button.disabled = false; });
            }
          }
        };
        const setMarketStatus = (message, type = "") => {
          const status = $("#market-status");
          status.textContent = message;
          status.classList.toggle("connected", type === "connected");
          status.classList.toggle("warning", type === "warning");
          status.classList.toggle("error", type === "error");
        };
        const loadApiStatus = async () => {
          try {
            const response = await fetch("/api/status");
            const status = await response.json();
            if (!response.ok) throw new Error(status.error || "Não foi possível verificar os provedores.");
            const missing = [];
            if (!status.finnhubConfigured) missing.push("FINNHUB_API_KEY");
            if (!status.brapiConfigured) missing.push("BRAPI_API_TOKEN");
            if (missing.length) {
              setMarketStatus(`Sem chave: ${missing.join(", ")}. B3/FIIs e câmbio usam brapi.dev; ativos internacionais e cripto usam Finnhub. Configure no .env apenas o que for usar e reinicie o servidor. Não compartilhe as chaves.`, "error");
            } else {
              setMarketStatus("Chaves dos dois provedores configuradas. Atualize para consultar cotações e proventos.", "connected");
            }
          } catch (error) {
            setMarketStatus(`Falha ao verificar as fontes de mercado: ${error.message}`, "error");
          }
        };
        const loadExchangeRates = async () => {
          try {
            const response = await fetch("/api/exchange");
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Não foi possível consultar o câmbio.");
            exchangeQuotes = payload;
            exchangeError = "";
            for (const [code, currency] of [["USD", "USD"], ["EUR", "EUR"]]) {
              const rate = payload[currency];
              if (!rate || !Number.isFinite(rate.mid)) {
                rates[code] = null;
                $(`#${code.toLowerCase()}-rate-label`).textContent = `${code} · cotação indisponível`;
                continue;
              }
              rates[code] = rate.mid;
              $(`#${code.toLowerCase()}-rate-label`).textContent = `${code} · 1 ${code} = ${format(rate.mid)}`;
            }
            const rate = payload.USD;
            $("#exchange-source").textContent = rate
              ? `${rate.source} · taxa diária atualizada ${formatMarketTime(rate.updatedAt)} (referência, não intradiária)`
              : "Cotação do dólar/euro indisponível nesta consulta.";
            render();
            loadRealPerformance();
          } catch (error) {
            exchangeError = error.message;
            $("#usd-rate-label").textContent = Number.isFinite(rates.USD) ? `USD · referência anterior ${format(rates.USD)}` : "USD · cotação indisponível";
            $("#eur-rate-label").textContent = Number.isFinite(rates.EUR) ? `EUR · referência anterior ${format(rates.EUR)}` : "EUR · cotação indisponível";
            $("#exchange-source").textContent = `Falha ao atualizar câmbio: ${error.message}${exchangeQuotes.USD ? " · mantendo última referência consultada." : ""}`;
            render();
            loadRealPerformance();
          }
        };
        const refreshPortfolio = async () => {
          if (refreshingPortfolio) return;
          refreshingPortfolio = true;
          const button = $("#refresh-portfolio");
          button.disabled = true;
          $("#portfolio-updated").textContent = "Consultando provedores...";
          try {
            if (!holdings.length) {
              $("#portfolio-updated").textContent = "Adicione ativos para acompanhar as cotações.";
              renderPortfolio();
              return;
            }
            const response = await fetch("/api/portfolio/quotes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ assets: holdings.map(({ symbol, market, currency, subType }) => ({ symbol, market, currency, subType })) })
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Não foi possível atualizar a carteira.");
            marketQuotes = { ...marketQuotes, ...payload.quotes };
            for (const [market, message] of Object.entries(payload.errors || {})) {
              if (market.includes("-dividends:")) {
                const [assetMarket, symbol] = market.split("-dividends:", 2);
                const holding = holdings.find((item) => item.market === assetMarket && item.symbol === symbol);
                if (holding) {
                  marketQuotes[symbol] = { ...(marketQuotes[symbol] || {}), dividendError: message };
                }
              } else if (market.endsWith("-dividends")) {
                const assetMarket = market.replace("-dividends", "");
                holdings.filter((item) => item.market === assetMarket).forEach((item) => {
                  marketQuotes[item.symbol] = { ...(marketQuotes[item.symbol] || {}), dividendError: message };
                });
              } else if (market.includes(":")) {
                const [, symbol] = market.split(":", 2);
                marketQuotes[symbol] = { ...(marketQuotes[symbol] || {}), error: message, warning: message };
              } else {
                holdings.filter((item) => item.market === market).forEach((item) => {
                  marketQuotes[item.symbol] = { ...(marketQuotes[item.symbol] || {}), error: message, warning: message };
                });
              }
            }
            for (const holding of holdings) {
              const freshQuote = payload.quotes[holding.symbol];
              if (freshQuote?.price) {
                holding.lastQuote = freshQuote;
              } else {
                const previousQuote = marketQuotes[holding.symbol] || holding.lastQuote;
                if (previousQuote) {
                  marketQuotes[holding.symbol] = {
                    ...previousQuote,
                    warning: previousQuote.warning || "O provedor não retornou uma cotação nova."
                  };
                  holding.lastQuote = marketQuotes[holding.symbol];
                }
              }
            }
            save();
            const when = new Date(payload.requestedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
            $("#portfolio-updated").textContent = `Consulta realizada ${when} · atualizações sujeitas ao plano dos provedores`;
            const providerErrors = Object.entries(payload.errors || {});
            if (providerErrors.length) {
              const onlyDividendErrors = providerErrors.every(([key]) => key.includes("-dividends"));
              const accessDenied = providerErrors.every(([, message]) => /plano|credencial|não permite este dado/i.test(message));
              if (onlyDividendErrors && accessDenied) {
                setMarketStatus(
                  "Cotações atualizadas. A brapi.dev não libera o histórico de proventos para o plano ou a chave configurada; por isso, a estimativa de dividendos fica indisponível. Os preços dos ativos continuam funcionando.",
                  "warning"
                );
              } else {
                setMarketStatus(Object.values(payload.errors).join(" · "), "error");
              }
            } else {
              setMarketStatus("Cotações e histórico de proventos atualizados. Rendimentos futuros não são garantidos.", "connected");
            }
            render();
          } catch (error) {
            $("#portfolio-updated").textContent = "Falha ao atualizar cotações.";
            setMarketStatus(error.message, "error");
          } finally {
            button.disabled = false;
            refreshingPortfolio = false;
          }
        };
        const refreshMarketOverview = async () => {
          const button = $("#refresh-market-overview");
          button.disabled = true;
          button.textContent = "Atualizando...";
          try {
            await Promise.all([loadExchangeRates(), refreshPortfolio()]);
          } finally {
            button.disabled = false;
            button.textContent = "Atualizar cotações";
          }
        };
        const showSearchMessage = (message) => {
          $("#asset-results").innerHTML = `<div class="asset-empty">${escapeHtml(message)}</div>`;
        };
        const searchAssets = async () => {
          const query = $("#asset-search").value.trim();
          if (!query) {
            showSearchMessage("Digite para pesquisar na lista de ativos do provedor.");
            return;
          }
          if (searchController) searchController.abort();
          searchController = new AbortController();
          showSearchMessage("Buscando ativos...");
          try {
            const params = new URLSearchParams({ market: searchMarket, q: query });
            const response = await fetch(`/api/search?${params}`, { signal: searchController.signal });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Não foi possível pesquisar ativos.");
            if (!payload.results.length) {
              showSearchMessage("Nenhum ativo encontrado. Confira o nome ou o ticker.");
              return;
            }
            $("#asset-results").innerHTML = payload.results.map((asset, index) => `<button class="asset-result" type="button" data-result-index="${index}">
              <span class="holding-logo">${escapeHtml(asset.symbol.slice(0, 3))}</span>
              <span class="asset-result-copy"><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.symbol)} · ${escapeHtml(asset.kind)} · ${escapeHtml(asset.source)}</small></span>
              ${Number.isFinite(asset.currentPrice) ? `<span class="asset-result-price">${format(asset.currentPrice, asset.currency)}</span>` : ""}
              <span class="asset-result-add">Selecionar</span>
            </button>`).join("");
            $("#asset-results").querySelectorAll("[data-result-index]").forEach((button, index) => {
              button.addEventListener("click", () => selectAsset(payload.results[index]));
            });
          } catch (error) {
            if (error.name !== "AbortError") showSearchMessage(error.message);
          }
        };
        const updateTradePreview = () => {
          const price = Number($("#asset-price").value);
          const quantity = Number($("#asset-quantity").value);
          const validPrice = Number.isFinite(price) && price > 0;
          const validQuantity = Number.isFinite(quantity) && quantity > 0;
          const preview = $("#trade-preview");
          const unitCurrency = selectedAsset?.currency || "BRL";
          preview.classList.toggle("warning", !validPrice && validQuantity);
          if (validPrice && validQuantity) {
            const operation = tradeMode === "sell" ? "Venda estimada" : "Total estimado da compra";
            preview.innerHTML = `${operation} · ${formatHoldingNumber(quantity)} × ${format(price, unitCurrency)}<strong>${format(price * quantity, unitCurrency)}</strong>`;
          } else if (tradeMode === "sell") {
            preview.innerHTML = "Informe quantidade e preço de venda.<strong>O valor será adicionado ao seu saldo em dinheiro</strong>";
          } else if (!validPrice && selectedAsset?.quoteUnavailable) {
            preview.innerHTML = "Cotação automática indisponível. Digite o preço por unidade que você pagou.<strong>A compra só será registrada com um preço válido</strong>";
          } else {
            preview.innerHTML = "Informe quantidade e preço para ver o total da operação.<strong>O total é calculado por quantidade × preço unitário</strong>";
          }
        };
        const selectAsset = async (asset) => {
          selectedAsset = asset;
          $("#asset-search-section").hidden = true;
          $("#selected-asset").hidden = false;
          $("#selected-asset").innerHTML = `<strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.symbol)} · ${escapeHtml(asset.kind)} · ${escapeHtml(asset.source)}</span>`;
          $("#asset-trade-form").hidden = false;
          $("#asset-price-currency").textContent = symbols[asset.currency] || asset.currency;
          $("#asset-price").value = "";
          $("#asset-price").placeholder = "Buscando cotação...";
          $("#asset-price").required = true;
          $("#asset-price-label").childNodes[0].textContent = `${tradeMode === "sell" ? "Preço de venda" : "Preço pago"} por unidade (`;
          $("#asset-price-currency").textContent = symbols[asset.currency] || asset.currency;
          $("#asset-quantity").removeAttribute("max");
          $("#asset-quantity").value = tradeMode === "sell"
            ? String(holdings.find((item) => item.symbol === asset.symbol)?.quantity ?? "")
            : "";
          $("#selected-quote").hidden = false;
          $("#selected-quote").innerHTML = `<span><span class="selected-quote-label">Preço de mercado por unidade</span><strong class="selected-quote-price">Buscando cotação...</strong></span><span class="selected-quote-meta">Consultando a fonte do ativo</span>`;
          const priorQuote = marketQuotes[asset.symbol] || asset.lastQuote
            || (Number.isFinite(asset.currentPrice)
              ? { price: asset.currentPrice, currency: asset.currency, updatedAt: asset.quoteUpdatedAt, source: "brapi.dev · cotação de referência" }
              : null);
          if (priorQuote?.price) {
            marketQuotes[asset.symbol] = priorQuote;
            $("#asset-price").value = String(priorQuote.price);
          }
          if (tradeMode === "sell") {
            $("#asset-price").closest(".field").hidden = false;
            $("#asset-quantity").value = String(holdings.find((item) => item.symbol === asset.symbol)?.quantity ?? "");
            $("#asset-quantity").focus();
          } else {
            $("#asset-price").closest(".field").hidden = false;
            $("#asset-quantity").focus();
          }
          updateTradePreview();
          if (tradeMode === "sell") {
            if (priorQuote) updateSelectedQuote(priorQuote);
            return;
          }
          try {
            const params = new URLSearchParams({ market: asset.market, symbol: asset.symbol });
            const response = await fetch(`/api/asset/quote?${params}`);
            const quote = await response.json();
            if (selectedAsset?.symbol !== asset.symbol) return;
            if (!response.ok) throw new Error(quote.error || "Cotação automática indisponível.");
            if (!Number.isFinite(quote.price) || quote.price <= 0) throw new Error("A fonte não retornou preço válido para este ativo.");
            marketQuotes[asset.symbol] = quote;
            selectedAsset.quoteUnavailable = false;
            $("#asset-price").value = String(quote.price);
            $("#asset-price").placeholder = format(quote.price, asset.currency);
            updateSelectedQuote(quote);
            updateTradePreview();
          } catch (error) {
            if (selectedAsset?.symbol !== asset.symbol) return;
            selectedAsset.quoteUnavailable = true;
            if (priorQuote) {
              marketQuotes[asset.symbol] = { ...priorQuote, warning: error.message };
              $("#asset-price").value = String(priorQuote.price);
              updateSelectedQuote({ ...priorQuote, warning: error.message });
            } else {
              $("#asset-price").value = "";
              $("#asset-price").placeholder = tradeMode === "sell" ? "Informe o preço de venda" : "Informe o preço que pagou";
              updateSelectedQuote({ error: error.message });
            }
            updateTradePreview();
          }
        };
        const updateSelectedQuote = (quote) => {
          const card = $("#selected-quote");
          card.hidden = false;
          const currency = selectedAsset?.currency || "BRL";
          const price = Number.isFinite(quote.price) ? format(quote.price, quote.currency || currency) : "Preço indisponível";
          const timestamp = quote.updatedAt ? formatMarketTime(quote.updatedAt) : "horário não informado pela fonte";
          const source = quote.source || "fonte configurada";
          const warning = quote.warning || quote.error;
          card.innerHTML = `<span><span class="selected-quote-label">Preço de mercado por unidade</span><strong class="selected-quote-price">${escapeHtml(price)}</strong></span><span class="selected-quote-meta">${escapeHtml(source)}<br>${escapeHtml(timestamp)}${warning ? `<br>${escapeHtml(warning)}` : ""}</span>`;
        };
        const openAssetModal = (asset = null, mode = "search") => {
          tradeMode = mode;
          selectedAsset = null;
          $("#asset-trade-form").reset();
          $("#asset-trade-form").hidden = true;
          $("#asset-search-section").hidden = Boolean(asset);
          $("#selected-asset").hidden = !asset;
          $("#selected-quote").hidden = !asset;
          $("#selected-asset").textContent = "";
          const editing = mode !== "search";
          $("#asset-modal-title").textContent = mode === "sell" ? "Registrar venda" : editing ? "Adicionar unidades" : "Adicionar à carteira";
          $("#asset-modal-description").textContent = mode === "sell"
            ? "Informe a quantidade e o preço de venda para registrar o valor recebido."
            : editing
              ? "Registre uma nova compra desta posição."
              : "Busque pelo nome ou ticker do ativo.";
          $("#asset-trade-submit").textContent = mode === "sell" ? "Registrar venda" : editing ? "Registrar compra" : "Adicionar à carteira";
          $("#asset-trade-note").textContent = mode === "sell"
            ? "A venda é registrada apenas no seu controle: o valor informado entra no saldo em dinheiro. Nenhuma ordem é enviada à corretora."
            : "A cotação de mercado preenche o preço por unidade; ajuste para o valor que você pagou. Esta tela não envia ordens à corretora.";
          if (asset) {
            const holding = holdings.find((item) => item.symbol === asset.symbol);
            selectAsset({
              symbol: asset.symbol,
              name: asset.name,
              market: asset.market,
              currency: asset.currency,
              subType: asset.subType,
              kind: marketLabel(asset.market, asset.subType),
              source: asset.source || (asset.market === "br" ? "brapi.dev" : "Finnhub"),
              currentPrice: asset.currentPrice,
              quoteUpdatedAt: asset.quoteUpdatedAt,
              lastQuote: holding?.lastQuote
            });
            if (mode === "sell") {
              $("#asset-price").closest(".field").hidden = false;
              $("#asset-quantity").max = holding?.quantity ?? "";
            } else {
              $("#asset-price").closest(".field").hidden = false;
              $("#asset-quantity").removeAttribute("max");
            }
          } else {
            $("#asset-price").closest(".field").hidden = false;
            $("#asset-price").required = true;
            $("#asset-quantity").removeAttribute("max");
            $("#trade-preview").classList.remove("warning");
            $("#trade-preview").innerHTML = "Informe quantidade e preço para ver o total da operação.<strong>O total é calculado por quantidade × preço unitário</strong>";
            searchMarket = "br";
            document.querySelectorAll(".market-option").forEach((button) => button.classList.toggle("active", button.dataset.market === searchMarket));
            $("#asset-search").value = "";
            showSearchMessage("Digite para pesquisar na lista de ativos do provedor.");
          }
          $("#asset-backdrop").classList.add("open");
          if (!asset) setTimeout(() => $("#asset-search").focus(), 30);
        };
        const closeAssetModal = () => {
          $("#asset-backdrop").classList.remove("open");
          $("#asset-trade-form").reset();
          $("#asset-price").closest(".field").hidden = false;
          $("#asset-price").required = true;
          $("#asset-price-label").childNodes[0].textContent = "Preço pago por unidade (";
          $("#asset-price-currency").textContent = "R$";
          $("#selected-quote").hidden = true;
          $("#asset-trade-submit").disabled = false;
          selectedAsset = null;
        };
        const saveAssetTrade = (event) => {
          event.preventDefault();
          if (!selectedAsset) return;
          const quantity = Number($("#asset-quantity").value);
          const typedPrice = $("#asset-price").value.trim() === "" ? null : Number($("#asset-price").value);
          if (!Number.isFinite(quantity) || quantity <= 0) {
            $("#asset-quantity").setCustomValidity("Informe uma quantidade maior que zero.");
            $("#asset-quantity").reportValidity();
            return;
          }
          $("#asset-quantity").setCustomValidity("");
          if (!Number.isFinite(typedPrice) || typedPrice <= 0) {
            $("#asset-price").setCustomValidity(tradeMode === "sell" ? "Informe um preço de venda por unidade maior que zero." : "Informe um preço por unidade maior que zero.");
            $("#asset-price").reportValidity();
            return;
          }
          $("#asset-price").setCustomValidity("");
          const existing = holdings.find((item) => item.symbol === selectedAsset.symbol);
          if (tradeMode === "sell") {
            if (!existing || quantity > existing.quantity) {
              $("#asset-quantity").setCustomValidity(`Você possui ${formatHoldingNumber(existing?.quantity || 0)} unidades.`);
              $("#asset-quantity").reportValidity();
              return;
            }
            const currency = existing.currency || selectedAsset.currency;
            const proceeds = Number((typedPrice * quantity).toFixed(2));
            state.balances[currency] = (state.balances[currency] || 0) + proceeds;
            state.transactions.unshift({
              id: Date.now(),
              type: "income",
              currency,
              amount: proceeds,
              description: `Venda de ${existing.symbol}`,
              date: `Hoje, ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`
            });
            existing.quantity = Math.round((existing.quantity - quantity) * 1e8) / 1e8;
            if (existing.quantity <= 0) holdings = holdings.filter((item) => item.symbol !== existing.symbol);
          } else {
            const quote = marketQuotes[selectedAsset.symbol] || selectedAsset.lastQuote;
            const purchasePrice = typedPrice;
            if (existing) {
              if (Number.isFinite(existing.averagePrice) && Number.isFinite(purchasePrice)) {
                existing.averagePrice = (existing.averagePrice * existing.quantity + purchasePrice * quantity) / (existing.quantity + quantity);
              } else if (!Number.isFinite(existing.averagePrice) && existing.quantity === 0) {
                existing.averagePrice = purchasePrice;
              } else if (!Number.isFinite(existing.averagePrice)) {
                existing.averagePrice = null;
              }
              existing.quantity = Math.round((existing.quantity + quantity) * 1e8) / 1e8;
              existing.lastQuote = quote || existing.lastQuote || null;
            } else {
              holdings.push({
                symbol: selectedAsset.symbol,
                name: selectedAsset.name,
                market: selectedAsset.market,
                currency: selectedAsset.currency,
                subType: selectedAsset.subType,
                source: selectedAsset.source,
                quantity,
                averagePrice: purchasePrice,
                lastQuote: quote || null
              });
            }
          }
          save();
          closeAssetModal();
          render();
          refreshPortfolio();
          showToast(tradeMode === "sell" ? "Venda registrada e valor adicionado ao saldo." : "Ativo adicionado à sua carteira.");
        };
        const openModal = (action) => {
          activeAction = action;
          const adding = action === "add";
          const exchanging = action === "exchange";
          $("#transaction-form").reset();
          $("#modal-title").textContent = exchanging ? "Câmbio entre moedas" : adding ? "Adicionar valor" : "Retirar valor";
          $("#modal-description").textContent = exchanging
            ? "Converta entre os saldos da sua carteira."
            : adding
              ? "Atualize sua carteira demonstrativa."
              : "Escolha a moeda e o valor que deseja retirar.";
          $("#submit-transaction").textContent = exchanging ? "Converter valor" : adding ? "Confirmar adição" : "Confirmar retirada";
          $("#submit-transaction").disabled = false;
          $("#destination-field").hidden = true;
          $("#exchange-preview").hidden = true;
          $("#modal-symbol").textContent = symbols.BRL;
          $("#modal-backdrop").classList.add("open");
          setTimeout(() => $("#amount").focus(), 30);
        };
        const closeModal = () => {
          $("#modal-backdrop").classList.remove("open");
          $("#transaction-form").reset();
          $("#modal-symbol").textContent = symbols.BRL;
          $("#destination-field").hidden = true;
          $("#exchange-preview").hidden = true;
          $("#exchange-preview").classList.remove("error");
        };

        document.querySelectorAll("[data-action]").forEach((button) => {
          button.addEventListener("click", () => openModal(button.dataset.action));
        });
        $("#close-modal").addEventListener("click", closeModal);
        $("#modal-backdrop").addEventListener("click", (event) => {
          if (event.target === $("#modal-backdrop")) closeModal();
        });
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            closeModal();
            closeAssetModal();
          }
        });
        const updateExchangePreview = () => {
          const source = $("#currency").value;
          const destination = $("#destination-currency").value;
          const rawAmount = $("#amount").value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
          const amount = Number(rawAmount);
          const preview = $("#exchange-preview");
          const ratesAvailable = Number.isFinite(rates[source]) && Number.isFinite(rates[destination]);
          preview.classList.toggle("error", source === destination || (amount > 0 && amount > state.balances[source]));
          if (source === destination) {
            preview.innerHTML = "<strong>Escolha moedas diferentes</strong>Selecione outra moeda para continuar.";
          } else if (amount > 0 && amount > state.balances[source]) {
            preview.innerHTML = `<strong>Saldo insuficiente</strong>Disponível: ${format(state.balances[source], source)}.`;
          } else if (!ratesAvailable) {
            preview.innerHTML = "<strong>Referência cambial indisponível</strong>Atualize as cotações e verifique a conexão com a brapi.dev.";
          } else {
            const converted = Number.isFinite(amount) && amount > 0
              ? Math.round(amount * rates[source] / rates[destination] * 100) / 100
              : 0;
            const rate = rates[source] / rates[destination];
            preview.innerHTML = `<strong>${format(converted, destination)}</strong>1 ${source} = ${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 }).format(rate)} ${destination} · PTAX indicativa diária`;
          }
          $("#submit-transaction").disabled = source === destination || !ratesAvailable || (amount > 0 && amount > state.balances[source]);
        };
        $("#currency").addEventListener("change", (event) => {
          $("#modal-symbol").textContent = symbols[event.target.value];
          if (activeAction === "exchange") updateExchangePreview();
        });
        $("#destination-currency").addEventListener("change", (event) => {
          event.currentTarget.setCustomValidity("");
          updateExchangePreview();
        });
        $("#amount").addEventListener("input", (event) => {
          event.currentTarget.setCustomValidity("");
          if (activeAction === "exchange") updateExchangePreview();
        });
        $("#transaction-filter").addEventListener("change", renderTransactions);
        document.querySelectorAll("[data-portfolio-period]").forEach((button) => {
          button.addEventListener("click", () => {
            portfolioHistoryPeriod = button.dataset.portfolioPeriod;
            document.querySelectorAll("[data-portfolio-period]").forEach((item) => {
              item.classList.toggle("active", item === button);
              item.setAttribute("aria-pressed", String(item === button));
            });
            renderPortfolioHistory(totalInReais());
          });
        });
        document.querySelectorAll("[data-tab]").forEach((button) => {
          button.addEventListener("click", () => {
            const tab = button.dataset.tab;
            document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === button));
            $("#overview-view").hidden = tab !== "overview";
            $("#portfolio-view").hidden = tab !== "portfolio";
            if (tab === "portfolio") refreshPortfolio();
          });
        });
        $("#add-asset").addEventListener("click", () => openAssetModal());
        $("#refresh-portfolio").addEventListener("click", refreshPortfolio);
        $("#refresh-market-overview").addEventListener("click", refreshMarketOverview);
        $("#market-currency-list").addEventListener("click", (event) => {
          const card = event.target.closest("[data-history-market]");
          if (card) loadMarketHistory(card.dataset.historyMarket, card.dataset.historySymbol, "1mo");
        });
        $("#market-watch-list").addEventListener("click", (event) => {
          const card = event.target.closest("[data-history-market]");
          if (card) loadMarketHistory(card.dataset.historyMarket, card.dataset.historySymbol, "1mo");
        });
        $("#close-history-modal").addEventListener("click", () => {
          ++historyRequestId;
          $("#history-backdrop").classList.remove("open");
        });
        $("#history-backdrop").addEventListener("click", (event) => {
          if (event.target === $("#history-backdrop")) {
            ++historyRequestId;
            $("#history-backdrop").classList.remove("open");
          }
        });
        document.querySelectorAll("[data-history-period]").forEach((button) => {
          button.addEventListener("click", () => {
            if (selectedHistory) {
              loadMarketHistory(selectedHistory.market, selectedHistory.symbol, button.dataset.historyPeriod);
            }
          });
        });
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && $("#history-backdrop").classList.contains("open")) {
            ++historyRequestId;
            $("#history-backdrop").classList.remove("open");
          }
        });
        $("#holding-filter").addEventListener("change", renderPortfolio);
        $("#close-asset-modal").addEventListener("click", closeAssetModal);
        $("#asset-backdrop").addEventListener("click", (event) => {
          if (event.target === $("#asset-backdrop")) closeAssetModal();
        });
        $("#asset-trade-form").addEventListener("submit", saveAssetTrade);
        $("#asset-quantity").addEventListener("input", (event) => {
          event.currentTarget.setCustomValidity("");
          updateTradePreview();
        });
        $("#asset-price").addEventListener("input", (event) => {
          event.currentTarget.setCustomValidity("");
          updateTradePreview();
        });
        $("#asset-search").addEventListener("input", () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(searchAssets, 300);
        });
        $("#asset-search").addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            clearTimeout(searchTimer);
            searchAssets();
          }
        });
        document.querySelectorAll(".market-option").forEach((button) => {
          button.addEventListener("click", () => {
            searchMarket = button.dataset.market;
            document.querySelectorAll(".market-option").forEach((option) => option.classList.toggle("active", option === button));
            $("#asset-search").value = "";
            clearTimeout(searchTimer);
            if (searchController) searchController.abort();
            showSearchMessage("Digite para pesquisar na lista de ativos do provedor.");
            $("#asset-search").focus();
          });
        });
        $("#visibility-toggle").addEventListener("click", (event) => {
          hidden = !hidden;
          event.currentTarget.setAttribute("aria-label", hidden ? "Mostrar saldo" : "Ocultar saldo");
          event.currentTarget.title = hidden ? "Mostrar saldo" : "Ocultar saldo";
          render();
        });
        $("#exchange-button").addEventListener("click", () => {
          openModal("exchange");
          $("#destination-field").hidden = false;
          $("#exchange-preview").hidden = false;
          $("#currency").value = "BRL";
          $("#destination-currency").value = "USD";
          $("#modal-symbol").textContent = symbols.BRL;
          updateExchangePreview();
        });
        $("#transaction-form").addEventListener("submit", (event) => {
          event.preventDefault();
          const currency = $("#currency").value;
          const rawAmount = $("#amount").value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
          const amount = Number(rawAmount);
          if (!Number.isFinite(amount) || amount <= 0) {
            $("#amount").setCustomValidity("Digite um valor maior que zero.");
            $("#amount").reportValidity();
            return;
          }
          $("#amount").setCustomValidity("");
          if (activeAction === "exchange") {
            const destination = $("#destination-currency").value;
            $("#destination-currency").setCustomValidity("");
            if (currency === destination) {
              $("#destination-currency").setCustomValidity("Escolha uma moeda diferente.");
              $("#destination-currency").reportValidity();
              return;
            }
            if (amount > state.balances[currency]) {
              $("#amount").setCustomValidity(`Saldo insuficiente em ${currencyNames[currency]}.`);
              $("#amount").reportValidity();
              return;
            }
            const converted = Math.round(amount * rates[currency] / rates[destination] * 100) / 100;
            if (!Number.isFinite(rates[currency]) || !Number.isFinite(rates[destination])) {
              $("#amount").setCustomValidity("Referência cambial indisponível. Atualize as cotações antes de converter.");
              $("#amount").reportValidity();
              return;
            }
            if (converted <= 0) {
              $("#amount").setCustomValidity("O valor é pequeno demais para converter.");
              $("#amount").reportValidity();
              return;
            }
            const now = new Date();
            const date = `Hoje, ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(now)}`;
            state.balances[currency] -= amount;
            state.balances[destination] += converted;
            const description = `Câmbio ${currency} → ${destination}`;
            state.transactions.unshift(
              { id: Date.now(), type: "income", currency: destination, amount: converted, description: `Câmbio recebido · ${currency} → ${destination}`, date },
              { id: Date.now() - 1, type: "expense", currency, amount, description: `Câmbio enviado · ${currency} → ${destination}`, date }
            );
            render();
            closeModal();
            showToast(`${format(amount, currency)} convertidos em ${format(converted, destination)}.`);
            return;
          }
          if (activeAction === "remove" && amount > state.balances[currency]) {
            $("#amount").setCustomValidity(`Saldo insuficiente em ${currencyNames[currency]}.`);
            $("#amount").reportValidity();
            return;
          }
          state.balances[currency] += activeAction === "add" ? amount : -amount;
          const now = new Date();
          state.transactions.unshift({
            id: Date.now(),
            type: activeAction === "add" ? "income" : "expense",
            currency,
            amount,
            description: $("#description").value.trim() || (activeAction === "add" ? "Valor adicionado" : "Retirada"),
            date: `Hoje, ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(now)}`
          });
          render();
          closeModal();
          showToast(activeAction === "add" ? "Valor adicionado à sua carteira." : "Retirada registrada.");
        });
        initializeAuth();
      })();
