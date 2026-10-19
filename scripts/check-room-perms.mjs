// 房间权限的行为验证（自己起一个隔离实例、自己关掉）。
//
// 用户 2026/10/15 问：「帮我检查一下非房主有没有加入下一首的权限，我有点忘了」。
// 这个契约值得固定下来 —— 尤其因为歌单行新加了【下一首】按钮，
// 它走的就是 queue-add + next:true 这条路。
//
// 设计意图（rooms.js 里那句注释）："队列类是人人可加，
// 只有删别人的、以及切歌才有限制"。
//   人人可做：加一首新的（队尾 / 下一首）、把任意一首挪到下一首、删自己加的
//   要控制权：切歌（playNow）、暂停/上一首/下一首、清空队列、删别人加的
//
// 用法：node scripts/check-room-perms.mjs
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hnmusic-perms-'));
const PORT = 8097;
const B = 'http://127.0.0.1:' + PORT;
const srv = spawn(process.execPath, ['src/index.js'], {
    cwd: 'F:/hnmusic',
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HN_DATA_DIR: DIR },
    stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('OK   ' + label); } else { fail++; console.log('FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

const post = async (p, body, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const guest = async () => (await post('/api/auth/guest', {})).data.token;
const connect = async (rid, token) => {
    const ac = new AbortController();
    const res = await fetch(B + '/api/rooms/' + rid + '/events', { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal });
    res.body.getReader().read().catch(() => {});
    return ac;
};
const TRACK = { bvid: 'BV1Aupg64ECJ', cid: '42626977003', title: '测试曲', author: 'up', cover: '', duration: 100 };

try {
    for (let i = 0; i < 40; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(250); } }

    const host = await guest();      // 建房的人 = 房主
    const other = await guest();     // 另一个人 = 非房主
    const room = (await post('/api/rooms', { name: '权限测试房' }, host)).data;
    const rid = room.roomId;
    const acH = await connect(rid, host);
    await sleep(150);
    const acO = await connect(rid, other);
    await sleep(250);

    const ctrl = (body, token) => post('/api/rooms/' + rid + '/control', body, token);

    // 房主先放一首，队列才有"当前项"
    await ctrl({ action: 'queue-add', ...TRACK, playNow: true }, host);
    await sleep(150);

    console.log('--- 非房主（没有任何授权）---');
    const addNext = await ctrl({ action: 'queue-add', ...TRACK, bvid: 'BV1sfLN6AErZ', next: true }, other);
    ok(addNext.status === 200, '① 【下一首】加一首新的 → 允许（200）', { status: addNext.status, err: addNext.data && addNext.data.error });

    const addTail = await ctrl({ action: 'queue-add', ...TRACK, bvid: 'BV1ibzyBUEaS' }, other);
    ok(addTail.status === 200, '② 【加入列表】加到队尾 → 允许（200）', { status: addTail.status, err: addTail.data && addTail.data.error });

    const playNow = await ctrl({ action: 'queue-add', ...TRACK, bvid: 'BV1wA411C7sr', playNow: true }, other);
    ok(playNow.status === 403, '③ 【播放】= 切歌 → **拒绝**（403）', { status: playNow.status, err: playNow.data && playNow.data.error });

    // 把别人加的那首挪到下一首（队列里 ≥2 首才动得了）
    const q = (await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + other } })).json()).queue;
    const late = q.items[q.items.length - 1];
    const mvOther = await ctrl({ action: 'queue-move', itemId: late.id, toNext: true }, other);
    ok(mvOther.status === 200, '④ 把**任意一首**挪到下一首（queue-move）→ 允许（200）', { status: mvOther.status, err: mvOther.data && mvOther.data.error });

    // 删别人加的
    const rmOther = await ctrl({ action: 'queue-remove', itemId: q.items[0].id }, other);
    ok(rmOther.status === 403, '⑤ 删**别人**加的 → 拒绝（403）', { status: rmOther.status, err: rmOther.data && rmOther.data.error });

    // 删自己加的
    const mine = (await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + other } })).json()).queue.items.find((x) => x.addedBy !== room.hostId);
    const rmMine = await ctrl({ action: 'queue-remove', itemId: mine.id }, other);
    ok(rmMine.status === 200, '⑥ 删**自己**加的 → 允许（200）', { status: rmMine.status, err: rmMine.data && rmMine.data.error });

    // 清空队列 / 暂停这种"切歌类"操作
    const clr = await ctrl({ action: 'queue-clear' }, other);
    ok(clr.status === 403, '⑦ 清空队列 → 拒绝（403）', { status: clr.status });
    const pause = await ctrl({ action: 'pause' }, other);
    ok(pause.status === 403, '⑧ 暂停 → 拒绝（403）', { status: pause.status });

    // 房主给授权后就都能做了。
    // ⚠️ 两个坑：① target 要用服务端给的 you.key（自己拼 's:'+sid 是错的）
    //           ② grant **不是** /control 的 action，它走 /api/rooms/:id/grant
    //              （前端 roomUrl('/grant') 就是这么调的）
    const meRoom = await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + other } })).json();
    console.log('     （非房主看到的 you: ' + JSON.stringify(meRoom.you) + '）');
    const grant = await post('/api/rooms/' + rid + '/grant', { target: meRoom.you.key, allow: true }, host);
    ok(grant.status === 200, '⑨a 房主授权成功（200）', { status: grant.status, err: grant.data && grant.data.error });
    await sleep(150);
    const pause2 = await ctrl({ action: 'pause' }, other);
    ok(pause2.status === 200, '⑨b 授权之后 → 可以切歌了（200）', { status: pause2.status, err: pause2.data && pause2.data.error });

    // ⑩⑪ 改房主：只有房主和管理员能动
    //（用户 2026/10/16："改成管理员可以随时改房主得了"）
    const outsider = await guest(); // 跟这个房间毫无关系的游客
    const t1 = await post('/api/rooms/' + rid + '/transfer', { target: meRoom.you.key }, outsider);
    ok(t1.status === 403, '⑩ 无关游客想改房主 → 拒绝（403）', { status: t1.status, err: t1.data && t1.data.error });

    acH.abort(); acO.abort();
    await sleep(200);

    // ⑫⑬ 开房带上自己的队列 / 离开时把房间队列并回来
    //（用户 2026/10/16："开房和离开的时候保留当前歌曲列表"）
    console.log('--- 队列能不能跟着房间来回走 ---');
    {
        const g = await guest();
        await post('/api/queue/items', { bvid: 'BV1Aupg64ECJ', cid: '42626977003', title: '我的一', cover: '', duration: 100 }, g);
        await post('/api/queue/items', { bvid: 'BV1whuL66E9o', cid: '40730625776', title: '我的二', cover: '', duration: 120 }, g);
        const mine0 = await (await fetch(B + '/api/queue', { headers: { Authorization: 'Bearer ' + g } })).json();
        ok(mine0.items.length === 2, '⑫a 自己队列里先放 2 首', mine0.items.length);

        const r = (await post('/api/rooms', { name: '带队列的房' }, g)).data;
        const titles = ((r.queue && r.queue.items) || []).map((x) => x.title);
        ok(titles.join(',') === '我的一,我的二', '⑫b 开房时把自己的队列带进房间了', titles);
        ok(r.isPlaying === false, '⑫c 新房不自动播（自动播会被浏览器拦，反而以为坏了）', r.isPlaying);

        // 房间里再加一首，然后 pull 回来
        await post('/api/rooms/' + r.roomId + '/control', { action: 'queue-add', bvid: 'BV1sfLN6AErZ', cid: '', title: '房间里加的', cover: '', duration: 90 }, g);
        const pulled = await post('/api/rooms/' + r.roomId + '/pull-queue', {}, g);
        ok(pulled.status === 200 && pulled.data.added === 1, '⑬a 离开时并回自己的队列（只补新的那首）', pulled.data);
        const mine1 = await (await fetch(B + '/api/queue', { headers: { Authorization: 'Bearer ' + g } })).json();
        ok(mine1.items.map((x) => x.title).join(',') === '我的一,我的二,房间里加的', '⑬b 合并去重、一条不丢', mine1.items.map((x) => x.title));
        // 再 pull 一次不该重复加
        const again = await post('/api/rooms/' + r.roomId + '/pull-queue', {}, g);
        ok(again.data.added === 0, '⑬c 再拉一次不会重复添加（幂等）', again.data);
        // 「正在播的那首」也要跟着定位
        const cur = mine1.items.find((x) => x.id === mine1.currentId);
        ok(!!cur, '⑬d 并回后 currentId 指向一首真实存在的歌', cur && cur.title);
        // 收尾
        const admin0 = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
        if (admin0) await fetch(B + '/api/rooms/' + r.roomId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin0 } });
    }

    // ⑭ 一整份歌单都已在房间里时，房主再按【播放全部】应该**开始播第一首**
    //（用户 2026/10/16 报「按了播放没跳转播放」——
    //  根因是 queue-add-batch 发现"全重复"就提前 return，把 playNow 整个丢了）
    console.log('--- 全都已在队列里时按【播放全部】 ---');
    {
        const h = await guest();
        const r = (await post('/api/rooms', { name: '播放全部复现房' }, h)).data;
        const rid2 = r.roomId;
        const list = [1, 2, 3].map((i) => ({ bvid: 'BV1TTEST000' + i, cid: 'cidtest' + i, title: '曲目' + i, cover: '', duration: 100 }));
        await post('/api/rooms/' + rid2 + '/control', { action: 'queue-add-batch', tracks: list }, h);
        const again = await post('/api/rooms/' + rid2 + '/control', { action: 'queue-add-batch', tracks: list, playNow: true }, h);
        ok(again.status === 200 && again.data.skipped === 3, '⑭a 第二次「播放全部」认得全重复', again.data && again.data.skipped);
        const st = await (await fetch(B + '/api/rooms/' + rid2, { headers: { Authorization: 'Bearer ' + h } })).json();
        const cur = st.queue.items.find((x) => x.id === st.queue.currentId);
        ok(!!cur && cur.bvid === list[0].bvid, '⑭b 切到了这批的第一首', cur && cur.title);
        ok(st.isPlaying === true, '⑭c 而且真的开始播了（以前这里什么也不发生）', st.isPlaying);
        // 权限没放松：非房主按了还是 403
        const other2 = await guest();
        const den = await post('/api/rooms/' + rid2 + '/control', { action: 'queue-add-batch', tracks: list, playNow: true }, other2);
        ok(den.status === 403, '⑭d 非房主按「播放全部」仍然 403', den.status);
        const admin1 = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
        if (admin1) await fetch(B + '/api/rooms/' + rid2, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin1 } });
    }

    // ⑮ 房间的"下一首"是**当前项的下一项**，不是队列第一项
    //（用户 2026/10/16：「按 ▶ 切到房间当前那首…之后播放的曲子是在这首之后的」。
    //  这是服务端 advance 的责任：它从 currentId 往后走 ✓ 这里把它钉住，
    //  免得以后有人改成"从头开始"或者"随机"）
    console.log('--- 房间里"之后放的是这首之后的" ---');
    {
        const h = await guest();
        const r = (await post('/api/rooms', { name: '顺序检查房' }, h)).data;
        const rid3 = r.roomId;
        const list = [1, 2, 3, 4, 5].map((i) => ({ bvid: 'BV1ORDER00' + i, cid: 'ord' + i, title: '第' + i + '首', cover: '', duration: 100 }));
        const added = await post('/api/rooms/' + rid3 + '/control', { action: 'queue-add-batch', tracks: list }, h);
        const items = added.data.queue.items;
        // 把当前项挪到第 3 首（action 是 play-item，参数是 itemId）
        await post('/api/rooms/' + rid3 + '/control', { action: 'play-item', itemId: items[2].id }, h);
        const nx = await post('/api/rooms/' + rid3 + '/control', { action: 'next' }, h);
        const after = nx.data.queue.items.find((x) => x.id === nx.data.queue.currentId);
        ok(after && after.title === '第4首', '⑮a 第3首按下一首 → 第4首（不是第1首、也不是随机）', after && after.title);
        const pv = await post('/api/rooms/' + rid3 + '/control', { action: 'prev' }, h);
        const back = pv.data.queue.items.find((x) => x.id === pv.data.queue.currentId);
        ok(back && back.title === '第3首', '⑮b 再按上一首 → 回到第3首', back && back.title);
        // 队列里没有的 id 不能把 currentId 搞坏
        const bad = await post('/api/rooms/' + rid3 + '/control', { action: 'play-item', itemId: 'iNOPE' }, h);
        ok(bad.status >= 400 || bad.data.queue.currentId === items[2].id, '⑮c 点一个不存在的项不会把队列搞坏', bad.status);
        const admin2 = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
        if (admin2) await fetch(B + '/api/rooms/' + rid3, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin2 } });
    }

        // ⑮b 开房要**保留你自己的当前曲目和进度**（用户 2026/10/17 要求：
        //     "开创房间以后保留列队当前播放到的进度"）
        {
            const g2 = await guest();
            await post('/api/queue/items', { bvid: 'BV1CUR001', cid: 'c1', title: '第一首', cover: '', duration: 100 }, g2);
            await post('/api/queue/items', { bvid: 'BV1CUR002', cid: 'c2', title: '第二首', cover: '', duration: 100 }, g2);
            await post('/api/queue/items', { bvid: 'BV1CUR003', cid: 'c3', title: '第三首', cover: '', duration: 100 }, g2);
            const mine = await (await fetch(B + '/api/queue', { headers: { Authorization: 'Bearer ' + g2 } })).json();
            // 把自己的当前曲目挪到第 2 首（模拟"听到一半"）
            // ⚠️ 接口收的是 itemId（我第一次写成 id，结果"当前曲目"压根没变 ✗
            //    —— 那一版失败是测试写错了，不是功能错了）
            const setCur = await post('/api/queue/current', { itemId: mine.items[1].id }, g2);
            ok(setCur.status === 200, '⑮b-0 把自己的当前曲目设到第 2 首', setCur.status);
            const r2 = (await post('/api/rooms', { name: '保留进度测试房', position: 42.5 }, g2)).data;
            const cur = r2.queue.items.find((x) => x.id === r2.queue.currentId);
            ok(r2.queue.items.length === 3, '⑮b-1 开房把自己的 3 首带进房间', r2.queue.items.length);
            ok(cur && cur.title === '第二首', '⑮b-2 当前曲目保留成"听到一半那首"（不是第一首）', cur && cur.title);
            ok(Math.abs(Number(r2.position) - 42.5) < 1.5, '⑮b-3 进度也带过去了（约 42.5 秒）', r2.position);
            ok(r2.isPlaying === false, '⑮b-4 房间仍然是暂停的（不自动播）', r2.isPlaying);
            const admin3 = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
            if (admin3) await fetch(B + '/api/rooms/' + r2.roomId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin3 } });
        }

    // ---------- 第二阶段：管理员（要现造一个，隔离实例里本来没有用户）----------
    // 关键点：**管理员不在房间里也能改** —— 房主因为刷新被系统交接给别人时，
    // 站长要能一句话改回来
    console.log('--- 管理员 ---');
    srv.kill();
    await sleep(400);
    const { spawnSync } = await import('node:child_process');
    const cli = spawnSync(process.execPath, ['scripts/admin.js', 'init', 'tester', '--password', 'test-pass-123'], {
        cwd: 'F:/hnmusic',
        env: { ...process.env, HN_DATA_DIR: DIR },
        stdio: 'ignore', // ⚠️ 用 ignore：沙箱里"管道捕获子进程输出"会被拒
    });
    ok(cli.status === 0, '⑪a 造出一个管理员（scripts/admin.js init，认 HN_DATA_DIR）', cli.status);

    const srv2 = spawn(process.execPath, ['src/index.js'], {
        cwd: 'F:/hnmusic',
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HN_DATA_DIR: DIR },
        stdio: 'ignore',
    });
    try {
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
            try { await fetch(B + '/api/health'); up = true; } catch { await sleep(250); }
        }
        if (!up) throw new Error('重启后没起来');

        const admin = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
        ok(!!admin, '⑪b 管理员登录成功');

        const host = await guest();
        const other = await guest();
        const room = (await post('/api/rooms', { name: '管理员改房主' }, host)).data;
        const rid2 = room.roomId;
        const aH = await connect(rid2, host);
        await sleep(150);
        const aO = await connect(rid2, other);
        await sleep(250);
        const youOther = (await (await fetch(B + '/api/rooms/' + rid2, { headers: { Authorization: 'Bearer ' + other } })).json()).you;
        const tr = await post('/api/rooms/' + rid2 + '/transfer', { target: youOther.key }, admin);
        ok(tr.status === 200, '⑪c 管理员（不在房间里）改房主 → 200', { status: tr.status, err: tr.data && tr.data.error });
        ok(tr.data && tr.data.hostId === youOther.key, '⑪d 房主确实换成了指定的人', tr.data && tr.data.hostId);
        const back = await post('/api/rooms/' + rid2 + '/transfer', { target: room.hostId }, admin);
        ok(back.status === 200 && back.data.hostId === room.hostId, '⑪e 管理员还能改回去', back.status);
        aH.abort(); aO.abort();
    } finally {
        srv2.kill();
    }
} catch (e) {
    fail++;
    console.log('FAIL 测试自身出错: ' + e.message);
} finally {
    srv.kill();
    await sleep(200);
    fs.rmSync(DIR, { recursive: true, force: true });
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
