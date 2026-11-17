// Teste ponta a ponta da Muuv Vaquinhas.
//
// Passa pelo Gateway com cookie, como o navegador, e confere login, campanha, doação,
// mensageria (RabbitMQ), concorrência e relatório. Não precisa instalar nada: só Node 20+.
//
//   node testes/e2e.mjs
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const LOGIN = process.env.LOGIN_URL ?? 'http://localhost:8081';
const CAMPANHA = process.env.CAMPANHA_URL ?? 'http://localhost:8082';
const DOACAO = process.env.DOACAO_URL ?? 'http://localhost:8083';
const RELATORIO = process.env.RELATORIO_URL ?? 'http://localhost:8084';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@muuv.com';
const ADMIN_SENHA = process.env.ADMIN_SENHA ?? 'admin123';
const ESPERA_EVENTOS_MS = Number(process.env.ESPERA_EVENTOS_MS ?? 15000);

// ---------------------------------------------------------------- utilidades

const resultados = [];

function check(id, nome, ok, detalhe = '') {
    resultados.push({ id, nome, ok: !!ok, detalhe });
    const n = String(resultados.length).padStart(2, '0');
    console.log(`${n}. ${ok ? 'PASS' : 'FAIL'} | ${id} - ${nome}${detalhe ? ' | ' + detalhe : ''}`);
    return !!ok;
}

function secao(titulo) {
    console.log(`\n=== ${titulo}`);
}

// Faz a requisição e devolve status, corpo (JSON se der) e o cookie access_token, se veio.
async function req(method, url, { body, cookie, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h['Cookie'] = `access_token=${cookie}`;
    const res = await fetch(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(15000),
    });
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = texto; }

    const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
    const linha = setCookies.find(c => c.startsWith('access_token='));
    const novoCookie = linha ? linha.split(';')[0].slice('access_token='.length) : undefined;
    return { status: res.status, json, cookie: novoCookie, setCookie: linha };
}

const esperarMs = ms => new Promise(r => setTimeout(r, ms));

// Repete fn até ela devolver algo "verdadeiro" ou estourar o tempo. Devolve o último resultado.
async function esperar(fn, ms = ESPERA_EVENTOS_MS) {
    const limite = Date.now() + ms;
    let ultimo;
    while (true) {
        ultimo = await fn();
        if (ultimo?.ok) return ultimo;
        if (Date.now() > limite) return ultimo;
        await esperarMs(300);
    }
}

const hoje = new Date();
const data = dias => new Date(hoje.getTime() + dias * 86400000).toISOString().slice(0, 10);
const num = v => Number(v);
const sufixo = Date.now().toString(36);

// Sonda sem efeito colateral: doar R$ 1000 numa vaquinha de meta 100.
//   404 = a Doação ainda não recebeu o evento da vaquinha
//   409 VALOR_EXCEDE_META = a cópia local já existe e está ativa
//   422 CAMPANHA_ENCERRADA = a cópia local já sabe que ela foi excluída
async function sondaDoacao(cookie, campanhaId) {
    return req('POST', `${GATEWAY}/doacao`, { cookie, body: { campanhaId, valor: 1000 } });
}

async function esperarDoacaoConhecer(cookie, campanhaId) {
    const r = await esperar(async () => {
        const s = await sondaDoacao(cookie, campanhaId);
        return { ...s, ok: s.status !== 404 };
    });
    return r;
}

// ---------------------------------------------------------------- testes

async function main() {
    console.log('Muuv Vaquinhas - teste ponta a ponta');
    console.log(`Gateway ${GATEWAY} | Login ${LOGIN} | Campanha ${CAMPANHA} | Doação ${DOACAO} | Relatório ${RELATORIO}`);

    // ---------- 0. Serviços no ar
    secao('Serviços no ar');
    let todosNoAr = true;
    for (const [nome, url] of [['Gateway', GATEWAY], ['Login', LOGIN], ['Campanha', CAMPANHA], ['Doação', DOACAO], ['Relatório', RELATORIO]]) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
            check('S0', `${nome} respondendo`, true, `${url} → HTTP ${r.status}`);
        } catch (e) {
            todosNoAr = check('S0', `${nome} respondendo`, false, `${url} não respondeu (${e.cause?.code ?? e.name})`) && todosNoAr;
        }
    }
    if (!todosNoAr) {
        console.log('\nSuba os serviços que falharam e rode de novo.');
        return fim();
    }

    // ---------- 1. Login (pelo gateway)
    secao('Login');
    const renata = { nome: 'Renata Teste', email: `renata.${sufixo}@teste.com`, senha: 'senha123' };
    const maria = { nome: 'Maria Teste', email: `maria.${sufixo}@teste.com`, senha: 'senha123' };

    let r = await req('POST', `${GATEWAY}/login/v1/create`, { body: renata });
    check('L1', 'Cadastrar criadora', r.status === 201 && r.cookie, `status ${r.status}, cookie ${r.cookie ? 'sim' : 'não'}`);
    check('L1', 'Cadastro vira CLIENTE', JSON.stringify(r.json?.roles) === '["CLIENTE"]', `roles ${JSON.stringify(r.json?.roles)}`);
    const renataId = r.json?.id;

    r = await req('POST', `${GATEWAY}/login/v1/create`, { body: maria });
    check('L2', 'Cadastrar doadora', r.status === 201, `status ${r.status}`);
    let cookieMaria = r.cookie;

    r = await req('POST', `${GATEWAY}/login/v1/create`, { body: maria });
    check('L3', 'E-mail repetido (409)', r.status === 409, `status ${r.status}`);

    r = await req('POST', `${GATEWAY}/login/auth`, { body: { email: renata.email, senha: 'errada', lembrar: true } });
    check('L4', 'Senha errada (401)', r.status === 401, `status ${r.status}`);

    r = await req('POST', `${GATEWAY}/login/auth`, { body: { email: renata.email, senha: renata.senha, lembrar: true } });
    check('L5', 'Login correto devolve cookie', r.status === 200 && r.cookie, `status ${r.status}`);
    const cookieRenata = r.cookie;
    check('L5', 'Cookie HttpOnly', /HttpOnly/i.test(r.setCookie ?? ''), r.setCookie ? '' : 'sem Set-Cookie');

    r = await req('GET', `${GATEWAY}/login/v1/me`, { cookie: cookieRenata });
    check('L6', 'Quem sou eu (com cookie)', r.status === 200 && r.json?.email === renata.email, `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/login/v1/me`);
    check('L7', 'Quem sou eu sem cookie (401)', r.status === 401, `status ${r.status}`);

    // ---------- 2. Gateway
    secao('Gateway');
    r = await req('GET', `${GATEWAY}/campanha/all`);
    check('G1', 'Rota protegida sem cookie (401)', r.status === 401, `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/campanha/all`, { cookie: 'token.invalido.123' });
    check('G2', 'Cookie inválido (401)', r.status === 401, `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/relatorio/operacoes`, { cookie: cookieRenata });
    check('G3', 'Relatório como CLIENTE (403)', r.status === 403, `status ${r.status}`);

    // ---------- 3. Campanha (pelo gateway, como a Renata)
    secao('Campanha');
    const novaVaquinha = (titulo, meta = 100, extra = {}) => ({
        titulo, descricao: 'Vaquinha criada pelo teste ponta a ponta', meta, dataLimite: data(30), ...extra,
    });

    r = await req('POST', `${GATEWAY}/campanha/save`, { cookie: cookieRenata, body: novaVaquinha(`Teste e2e ${sufixo}`) });
    check('C1', 'Criar vaquinha (201)', r.status === 201, `status ${r.status}`);
    check('C1', 'Nasce ABERTA, arrecadado 0, criadora certa',
        r.json?.status === 'ABERTA' && num(r.json?.valorArrecadado) === 0 && r.json?.criadorNome === renata.nome,
        `status ${r.json?.status}, arrecadado ${r.json?.valorArrecadado}, criador ${r.json?.criadorNome}`);
    const vaquinha = r.json;
    if (!vaquinha?.id) {
        console.log('\nSem a vaquinha do C1 não dá para seguir.');
        return fim();
    }

    r = await req('POST', `${GATEWAY}/campanha/save`, { cookie: cookieRenata, body: novaVaquinha('Meta zero', 0) });
    check('C2', 'Meta 0 (400)', r.status === 400, `status ${r.status}`);
    r = await req('POST', `${GATEWAY}/campanha/save`, { cookie: cookieRenata, body: novaVaquinha('ab') });
    check('C3', 'Título curto (400)', r.status === 400, `status ${r.status}`);
    r = await req('POST', `${GATEWAY}/campanha/save`, { cookie: cookieRenata, body: novaVaquinha('Data passada', 100, { dataLimite: data(-1) }) });
    check('C4', 'Data no passado (400)', r.status === 400, `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/campanha/all`, { cookie: cookieRenata });
    check('C5', 'Listar todas contém a nova', r.status === 200 && r.json?.some?.(c => c.id === vaquinha.id), `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/campanha/${vaquinha.id}`, { cookie: cookieMaria });
    check('C6', 'Buscar por id', r.status === 200 && r.json?.id === vaquinha.id, `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/campanha/minhas`, { cookie: cookieRenata });
    check('C7', 'Minhas vaquinhas: só as da criadora',
        r.status === 200 && r.json?.some?.(c => c.id === vaquinha.id) && r.json.every(c => c.criadorId === renataId),
        `status ${r.status}, ${r.json?.length} vaquinha(s)`);

    r = await req('GET', `${GATEWAY}/campanha/minhas`, { cookie: cookieMaria, headers: { 'X-User-Id': renataId } });
    check('C8', 'X-User-Id forjado é ignorado pelo gateway',
        r.status === 200 && !r.json?.some?.(c => c.id === vaquinha.id), `status ${r.status}, ${r.json?.length} vaquinha(s)`);

    const edicao = { id: vaquinha.id, titulo: `Teste e2e ${sufixo} (editada)`, descricao: vaquinha.descricao, meta: 100, dataLimite: data(31) };
    r = await req('PUT', `${GATEWAY}/campanha/update`, { cookie: cookieMaria, body: edicao });
    check('C9', 'Editar com outro usuário (403)', r.status === 403, `status ${r.status}`);
    r = await req('PUT', `${GATEWAY}/campanha/update`, { cookie: cookieRenata, body: edicao });
    check('C10', 'Editar como criadora (200)', r.status === 200 && r.json?.titulo === edicao.titulo, `status ${r.status}`);

    r = await req('POST', `${CAMPANHA}/campanha/save`, { body: novaVaquinha('Sem headers') });
    check('C11', 'Direto na Campanha sem X-User (401)', r.status === 401, `status ${r.status}`);

    r = await req('GET', `${GATEWAY}/campanha/naoexiste-${sufixo}`, { cookie: cookieRenata });
    check('C12', 'Vaquinha inexistente (404)', r.status === 404, `status ${r.status}`);

    // ---------- 4. Doação (pelo gateway, como a Maria)
    secao('Doação');
    r = await esperarDoacaoConhecer(cookieMaria, vaquinha.id);
    if (!check('D0', 'Doação recebeu a vaquinha pelo RabbitMQ (campanha.criada)', r.status !== 404,
        r.status === 404 ? `ainda 404 depois de ${ESPERA_EVENTOS_MS} ms: confira a fila doacao.campanha-eventos` : `status ${r.status}`)) {
        return fim();
    }

    r = await req('POST', `${GATEWAY}/doacao`, { cookie: cookieMaria, body: { campanhaId: vaquinha.id, valor: 30 } });
    check('D1', 'Doar R$ 30 (201)', r.status === 201, `status ${r.status}${r.status !== 201 ? ' ' + JSON.stringify(r.json) : ''}`);
    check('D1', 'CONCLUIDA, arrecadado 30, faltam 70',
        r.json?.status === 'CONCLUIDA' && num(r.json?.valorArrecadado) === 30 && num(r.json?.valorRestante) === 70,
        `status ${r.json?.status}, arrecadado ${r.json?.valorArrecadado}, restante ${r.json?.valorRestante}`);
    const operacaoD1 = r.json?.operacaoId;

    r = await sondaDoacao(cookieMaria, vaquinha.id);
    check('D2', 'Doar mais que o restante (409 VALOR_EXCEDE_META)',
        r.status === 409 && r.json?.motivo === 'VALOR_EXCEDE_META' && num(r.json?.valorRestante) === 70,
        `status ${r.status}, motivo ${r.json?.motivo}, restante ${r.json?.valorRestante}`);

    r = await req('POST', `${GATEWAY}/doacao`, { cookie: cookieMaria, body: { campanhaId: vaquinha.id, valor: 0 } });
    check('D3', 'Doar R$ 0 (400)', r.status === 400, `status ${r.status}`);
    r = await req('POST', `${GATEWAY}/doacao`, { cookie: cookieMaria, body: `{"campanhaId":"${vaquinha.id}","valor":10.555}` });
    check('D4', 'Doar com 3 casas decimais (400)', r.status === 400, `status ${r.status}`);
    r = await req('POST', `${DOACAO}/doacao`, { body: { campanhaId: vaquinha.id, valor: 1 } });
    check('D5', 'Direto na Doação sem X-User (401)', r.status === 401, `status ${r.status}`);
    r = await req('POST', `${GATEWAY}/doacao`, { cookie: cookieMaria, body: { campanhaId: `naoexiste-${sufixo}`, valor: 10 } });
    check('D6', 'Vaquinha inexistente (404)', r.status === 404, `status ${r.status}`);

    r = await esperar(async () => {
        const c = await req('GET', `${GATEWAY}/campanha/${vaquinha.id}`, { cookie: cookieRenata });
        return { ...c, ok: num(c.json?.valorArrecadado) === 30 && c.json?.totalDoacoes === 1 };
    });
    check('D7', 'Campanha somou a doação (doacao.realizada, assíncrono)', r.ok,
        `arrecadado ${r.json?.valorArrecadado}, doações ${r.json?.totalDoacoes}`);

    r = await req('GET', `${GATEWAY}/doacao/campanha/${vaquinha.id}`, { cookie: cookieRenata });
    check('D8', 'Listar doações da vaquinha', r.status === 200 && r.json?.some?.(d => d.doadorNome === maria.nome && num(d.valor) === 30),
        `status ${r.status}, ${r.json?.length} doação(ões)`);

    r = await req('DELETE', `${GATEWAY}/campanha/delete/${vaquinha.id}`, { cookie: cookieRenata });
    check('D9', 'Excluir vaquinha com doação (409)', r.status === 409, `status ${r.status}`);

    // Vaquinha excluída não aceita doação
    r = await req('POST', `${GATEWAY}/campanha/save`, { cookie: cookieRenata, body: novaVaquinha(`Excluir ${sufixo}`) });
    const paraExcluir = r.json;
    await esperarDoacaoConhecer(cookieMaria, paraExcluir?.id);
    r = await req('DELETE', `${GATEWAY}/campanha/delete/${paraExcluir?.id}`, { cookie: cookieRenata });
    check('D10', 'Excluir vaquinha sem doação (204)', r.status === 204, `status ${r.status}`);
    r = await req('GET', `${GATEWAY}/campanha/${paraExcluir?.id}`, { cookie: cookieRenata });
    check('D10', 'Excluída some da Campanha (404)', r.status === 404, `status ${r.status}`);
    r = await esperar(async () => {
        const s = await sondaDoacao(cookieMaria, paraExcluir?.id);
        return { ...s, ok: s.status === 422 };
    });
    check('D11', 'Doar em vaquinha excluída (422 CAMPANHA_ENCERRADA, via campanha.excluida)',
        r.status === 422 && r.json?.motivo === 'CAMPANHA_ENCERRADA', `status ${r.status}, motivo ${r.json?.motivo}`);

    // ---------- 5. Concorrência
    secao('Concorrência');
    r = await req('POST', `${GATEWAY}/campanha/save`, { cookie: cookieRenata, body: novaVaquinha(`Concorrência ${sufixo}`) });
    const disputada = r.json;
    await esperarDoacaoConhecer(cookieMaria, disputada?.id);
    r = await req('POST', `${GATEWAY}/doacao`, { cookie: cookieMaria, body: { campanhaId: disputada?.id, valor: 30 } });
    check('X1', 'Preparar: doar R$ 30 (faltam 70)', r.status === 201, `status ${r.status}`);

    const respostas = await Promise.all(Array.from({ length: 10 }, () =>
        req('POST', `${GATEWAY}/doacao`, { cookie: cookieMaria, body: { campanhaId: disputada?.id, valor: 10 } })));
    const aceitas = respostas.filter(x => x.status === 201).length;
    const recusadas = respostas.filter(x => x.status === 409 && ['VALOR_EXCEDE_META', 'META_ATINGIDA'].includes(x.json?.motivo)).length;
    const outras = respostas.filter(x => x.status !== 201 && !(x.status === 409 && x.json?.motivo));
    check('X2', '10 doações de R$ 10 ao mesmo tempo: 7 aceitas e 3 recusadas', aceitas === 7 && recusadas === 3,
        `${aceitas} aceitas, ${recusadas} recusadas${outras.length ? `, ${outras.length} outras: ${outras.map(o => o.status + ' ' + (o.json?.mensagem ?? '')).join('; ')}` : ''}`);

    r = await esperar(async () => {
        const c = await req('GET', `${GATEWAY}/campanha/${disputada?.id}`, { cookie: cookieRenata });
        return { ...c, ok: num(c.json?.valorArrecadado) === 100 && c.json?.totalDoacoes === 8 && c.json?.status === 'META_ATINGIDA' };
    });
    check('X3', 'Total fecha em exatamente R$ 100, 8 doações, META_ATINGIDA', r.ok,
        `arrecadado ${r.json?.valorArrecadado}, doações ${r.json?.totalDoacoes}, status ${r.json?.status}`);

    // ---------- 6. Relatório (ADMIN)
    secao('Relatório');
    r = await req('POST', `${GATEWAY}/login/auth`, { body: { email: ADMIN_EMAIL, senha: ADMIN_SENHA, lembrar: false } });
    check('R1', 'Login do admin', r.status === 200 && r.json?.roles?.includes('ADMIN'), `status ${r.status}, roles ${JSON.stringify(r.json?.roles)}`);
    const cookieAdmin = r.cookie;

    r = await esperar(async () => {
        const x = await req('GET', `${GATEWAY}/relatorio/operacoes`, { cookie: cookieAdmin });
        return { ...x, ok: x.status === 200 && x.json?.some?.(o => o.operacaoId === operacaoD1 && o.status === 'CONCLUIDA') };
    });
    check('R2', 'Painel mostra a doação do D1 como CONCLUIDA (operacao.doacao)', r.ok, `status ${r.status}`);
    const ops = Array.isArray(r.json) ? r.json : [];
    check('R3', 'Painel mostra recusa VALOR_EXCEDE_META',
        ops.some(o => o.campanhaId === vaquinha.id && o.status === 'RECUSADA' && o.motivo === 'VALOR_EXCEDE_META'));
    check('R4', 'Painel mostra a criação da vaquinha (campanha.criada)',
        ops.some(o => o.campanhaId === vaquinha.id && o.tipo === 'CAMPANHA_CRIADA'));
    const travadas = lista => lista.filter(o => [vaquinha.id, disputada?.id].includes(o.campanhaId)
        && o.tipo === 'DOACAO' && !['CONCLUIDA', 'RECUSADA', 'ERRO'].includes(o.status));
    r = await esperar(async () => {
        const x = await req('GET', `${GATEWAY}/relatorio/operacoes`, { cookie: cookieAdmin });
        const doRodada = (Array.isArray(x.json) ? x.json : []).filter(o => o.campanhaId === disputada?.id && o.tipo === 'DOACAO');
        return { ...x, ok: doRodada.length >= 11 && travadas(x.json).length === 0, doRodada };
    });
    check('R5', 'Todas as 11 doações da disputa terminaram em status final no painel', r.ok,
        `${r.doRodada?.length ?? 0} operação(ões) da disputa, ${Array.isArray(r.json) ? travadas(r.json).length : '?'} sem status final`);

    r = await req('GET', `${RELATORIO}/relatorio/operacoes`);
    check('R6', 'Direto no Relatório sem X-User-Roles (401)', r.status === 401, `status ${r.status}`);

    // ---------- 7. Logout
    secao('Logout');
    r = await req('POST', `${GATEWAY}/login/v1/logout`, { cookie: cookieRenata });
    check('L8', 'Logout apaga o cookie', r.status === 204 && /Max-Age=0/i.test(r.setCookie ?? ''), `status ${r.status}`);

    fim();
}

function fim() {
    const falhas = resultados.filter(x => !x.ok);
    console.log(`\n${resultados.length - falhas.length} de ${resultados.length} passaram.`);
    if (falhas.length) {
        console.log('Falharam: ' + falhas.map(f => f.id).filter((v, i, a) => a.indexOf(v) === i).join(', '));
        process.exitCode = 1;
    }
}

main().catch(e => {
    console.error('\nErro inesperado no teste:', e);
    process.exitCode = 1;
});
