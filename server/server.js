const express = require('express');
const cors = require('cors');
const path = require('path');
// Load env configuration
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { db, initDb } = require('./database');
const { notifyStatusChange, syncToGoogleSheets } = require('./notifications');
const { getSettings, saveSettings } = require('./settings_manager');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve static files from the React frontend build folder
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get all validators from Supabase dynamically
async function getValidatorsFromDb() {
  const { data, error } = await db
    .from('validators')
    .select('code')
    .order('code', { ascending: true });
    
  if (error) throw error;
  return data.map(r => r.code);
}

// 1. GET /api/refunds - Filtered list of refunds with server-side pagination, search, and warning check
app.get('/api/refunds', async (req, res) => {
  const page = parseInt(req.query.page || '1');
  const limit = parseInt(req.query.limit || '10');
  const offset = (page - 1) * limit;

  const search = req.query.search || '';
  const status = req.query.status || '';
  const systemType = req.query.system_type || '';
  const validator = req.query.validator || '';
  const dateStart = req.query.date_start || '';
  const dateEnd = req.query.date_end || '';
  const onlyWarnings = req.query.only_warnings === 'true';
  const onlyPending = req.query.only_pending === 'true';

  try {
    let query = db.from('refund_applications').select('*', { count: 'exact' });

    // Warning filter: status in progress and updated more than 90 days ago
    if (onlyWarnings) {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const dateStr = ninetyDaysAgo.toISOString().split('T')[0];
      query = query
        .not('status', 'in', '("Авторизовано","Отклонено","авторизовано с расхождением")')
        .lte('status_updated_at', dateStr);
    }

    // Pending filter: status in progress ('Создан', 'На проверке')
    if (onlyPending) {
      query = query.in('status', ['Создан', 'На проверке']);
    }

    // Search filter
    if (search) {
      const term = `%${search}%`;
      query = query.or(`ticket_number.ilike.${term},bsp_request_number.ilike.${term},tch_request_number.ilike.${term},agent_name.ilike.${term},requested_by.ilike.${term},validator.ilike.${term}`);
    }

    // Dropdown filters
    if (status) query = query.eq('status', status);
    if (systemType) query = query.eq('system_type', systemType);
    if (validator) query = query.eq('validator', validator);

    // Date filters
    if (dateStart) query = query.gte('request_date', dateStart);
    if (dateEnd) query = query.lte('request_date', dateEnd);

    // Order and paginate
    query = query
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      data: data || [],
      pagination: {
        page,
        limit,
        totalRecords: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/refunds/stats - Dashboard metrics (grouped by currency for authorized sum)
app.get('/api/refunds/stats', async (req, res) => {
  try {
    // Count total pending
    const { count: totalPending, error: pendingErr } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .in('status', ['Создан', 'На проверке']);
    if (pendingErr) throw pendingErr;

    // Count 90+ days warning items (in progress)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateStr = ninetyDaysAgo.toISOString().split('T')[0];
    const { count: activeWarningsCount, error: warnErr } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '("Авторизовано","Отклонено","авторизовано с расхождением")')
      .lte('status_updated_at', dateStr);
    if (warnErr) throw warnErr;

    // Total tickets in system
    const { count: totalCreated, error: totalErr } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true });
    if (totalErr) throw totalErr;

    // Sum of authorized refund amounts grouped by currency
    // For 'авторизовано с расхождением' we use the authorized_amount, otherwise the main amount
    const { data: authData, error: authErr } = await db
      .from('refund_applications')
      .select('currency, status, amount, authorized_amount')
      .in('status', ['Авторизовано', 'авторизовано с расхождением']);
    if (authErr) throw authErr;

    const sumsByCurrency = {};
    if (authData) {
      for (const row of authData) {
        const val = row.status === 'авторизовано с расхождением' ? (row.authorized_amount || 0) : (row.amount || 0);
        sumsByCurrency[row.currency] = (sumsByCurrency[row.currency] || 0) + parseFloat(val);
      }
    }

    const authorizedSums = Object.keys(sumsByCurrency).map(curr => ({
      currency: curr,
      sum: Math.round(sumsByCurrency[curr] * 100) / 100
    }));

    res.json({
      totalPending: totalPending || 0,
      authorizedSums,
      activeWarningsCount: activeWarningsCount || 0,
      totalCreated: totalCreated || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/refunds - Create new application
app.post('/api/refunds', async (req, res) => {
  const {
    ticket_number,
    bsp_request_number,
    tch_request_number,
    system_type,
    validator,
    request_date,
    amount_eur, // This maps to the amount value (numeric)
    currency,   // Selected currency from form (RUB, TRY, EUR, etc.)
    agent_refund_equivalent,
    agent_name,
    requested_by,
    operator_email,
    operator_rocketchat,
    comment
  } = req.body;

  // Basic Validation
  if (!ticket_number || ticket_number.length !== 13 || isNaN(ticket_number)) {
    return res.status(400).json({ error: "Номер билета должен состоять ровно из 13 цифр." });
  }
  if (!system_type || !validator || !request_date || !amount_eur || !agent_name || !requested_by || !operator_rocketchat) {
    return res.status(400).json({ error: "Пожалуйста, заполните все обязательные поля." });
  }

  const status = 'Создан';

  try {
    const { data: newTicket, error } = await db
      .from('refund_applications')
      .insert([
        {
          ticket_number,
          bsp_request_number: bsp_request_number || null,
          tch_request_number: tch_request_number || null,
          system_type,
          validator,
          request_date,
          amount: parseFloat(amount_eur),
          currency: currency || 'EUR',
          agent_refund_equivalent: agent_refund_equivalent ? parseFloat(agent_refund_equivalent) : null,
          agent_name,
          requested_by,
          operator_email: operator_email || null,
          operator_rocketchat: operator_rocketchat || null,
          status,
          status_updated_at: request_date
        }
      ])
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: "Заявка с таким номером билета уже существует." });
      }
      throw error;
    }

    const newId = newTicket.id;
    const historyComment = comment ? `Создание: ${comment}` : 'Создание новой заявки';

    // Log in status history
    const { error: histErr } = await db
      .from('status_history')
      .insert([
        {
          application_id: newId,
          old_status: null,
          new_status: status,
          changed_by: requested_by,
          comment: historyComment
        }
      ]);

    if (histErr) console.error("History logging error:", histErr.message);

    // Sync newly created ticket to Google Sheets (with action metadata)
    syncToGoogleSheets({
      action: 'create',
      changed_by: requested_by,
      comment: comment || 'Создание новой заявки',
      old_status: null,
      ticket: newTicket
    }).catch(e => console.error("Google Sheets sync failed:", e));

    res.status(201).json({ id: newId, ticket_number, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT /api/refunds/:id/status - Update refund status with optional comment & authorized_amount
app.put('/api/refunds/:id/status', async (req, res) => {
  const { id } = req.params;
  const { new_status, comment, changed_by, authorized_amount } = req.body;
  const operatorName = changed_by || 'СОФИ';

  if (!new_status) {
    return res.status(400).json({ error: "Укажите новый статус." });
  }

  try {
    // Fetch current ticket details
    const { data: ticket, error: findErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (findErr) throw findErr;
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена." });

    const oldStatus = ticket.status;
    const ticketNumber = ticket.ticket_number;
    const operatorCreator = ticket.requested_by;
    const operatorEmail = ticket.operator_email;
    const operatorRocketChat = ticket.operator_rocketchat;
    const today = new Date().toISOString().split('T')[0];
    const amount = ticket.amount;
    const currency = ticket.currency;

    const updateData = {
      status: new_status,
      status_updated_at: today,
      updated_at: new Date().toISOString()
    };

    if (new_status === 'авторизовано с расхождением') {
      updateData.authorized_amount = parseFloat(authorized_amount || '0');
    } else {
      updateData.authorized_amount = null;
    }

    const { error: updateErr } = await db
      .from('refund_applications')
      .update(updateData)
      .eq('id', id);

    if (updateErr) throw updateErr;

    // Save status history audit log
    const { error: histErr } = await db
      .from('status_history')
      .insert([
        {
          application_id: id,
          old_status: oldStatus,
          new_status: new_status,
          changed_by: operatorName,
          comment: comment || null
        }
      ]);

    if (histErr) console.error("Audit log insert failed:", histErr.message);

    // Fetch updated ticket to get final values for Sheets
    const { data: updatedTicket, error: getErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (!getErr && updatedTicket) {
      // Trigger notifications async
      notifyStatusChange({
        ticketNumber,
        oldStatus,
        newStatus: new_status,
        changedBy: operatorName,
        comment,
        operatorEmail,
        operatorRocketChat,
        operatorName: operatorCreator,
        amount,
        currency,
        authorizedAmount: parseFloat(authorized_amount || '0'),
        systemType: ticket.system_type,
        bspRequestNumber: ticket.bsp_request_number,
        tchRequestNumber: ticket.tch_request_number
      }).catch(e => console.error("Notifications triggering error:", e.message));

      // Sync updated ticket to Google Sheets
      syncToGoogleSheets({
        action: 'status_change',
        changed_by: operatorName,
        comment: comment || null,
        old_status: oldStatus,
        ticket: updatedTicket
      }).catch(e => console.error("Google Sheets sync failed:", e));
    }

    res.json({ id, old_status: oldStatus, new_status, message: "Статус успешно обновлен." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4b. PUT /api/refunds/:id - Update refund details (Edit)
app.put('/api/refunds/:id', async (req, res) => {
  const { id } = req.params;
  const {
    ticket_number,
    bsp_request_number,
    tch_request_number,
    system_type,
    validator,
    request_date,
    amount_eur,
    currency,
    agent_refund_equivalent,
    agent_name,
    requested_by,
    operator_email,
    operator_rocketchat,
    comment
  } = req.body;

  if (!ticket_number || ticket_number.length !== 13 || isNaN(ticket_number)) {
    return res.status(400).json({ error: "Номер билета должен состоять ровно из 13 цифр." });
  }
  if (!system_type || !validator || !request_date || !amount_eur || !agent_name || !requested_by || !operator_rocketchat) {
    return res.status(400).json({ error: "Пожалуйста, заполните все обязательные поля." });
  }

  try {
    // Fetch old ticket details to get previous status
    const { data: oldTicket, error: getOldErr } = await db
      .from('refund_applications')
      .select('status')
      .eq('id', id)
      .single();
    
    const oldStatus = oldTicket ? oldTicket.status : null;

    // Update DB
    const { error: updateErr } = await db
      .from('refund_applications')
      .update({
        ticket_number,
        bsp_request_number: bsp_request_number || null,
        tch_request_number: tch_request_number || null,
        system_type,
        validator,
        request_date,
        amount: parseFloat(amount_eur),
        currency,
        agent_refund_equivalent: agent_refund_equivalent ? parseFloat(agent_refund_equivalent) : null,
        agent_name,
        requested_by,
        operator_email: operator_email || null,
        operator_rocketchat: operator_rocketchat || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateErr) {
      if (updateErr.code === '23505') {
        return res.status(400).json({ error: "Заявка с таким номером билета уже существует." });
      }
      throw updateErr;
    }

    const commentText = comment ? `Редактирование: ${comment}` : 'Редактирование параметров заявки';
    
    // Log to audit history
    const { error: histErr } = await db
      .from('status_history')
      .insert([
        {
          application_id: id,
          old_status: 'Изменен',
          new_status: 'Изменен',
          changed_by: requested_by,
          comment: commentText
        }
      ]);

    if (histErr) console.error("Edit audit log failed:", histErr.message);

    // Fetch updated ticket and sync it to Google Sheets
    const { data: updatedTicket, error: getErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (!getErr && updatedTicket) {
      syncToGoogleSheets({
        action: 'edit',
        changed_by: requested_by,
        comment: comment || 'Редактирование параметров заявки',
        old_status: oldStatus,
        ticket: updatedTicket
      }).catch(e => console.error("Google Sheets sync failed:", e));
    }

    res.json({ success: true, message: "Заявка успешно отредактирована." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4c. DELETE /api/refunds/:id - Delete refund application
app.delete('/api/refunds/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await db
      .from('refund_applications')
      .delete()
      .eq('id', id);
      
    if (error) throw error;
    res.json({ success: true, message: "Заявка успешно удалена." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. GET /api/refunds/:id/history - Get status audit trail
app.get('/api/refunds/:id/history', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await db
      .from('status_history')
      .select('*')
      .eq('application_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. GET /api/notifications - Get in-app notifications
app.get('/api/notifications', async (req, res) => {
  const recipient = req.query.recipient || ''; 
  
  try {
    let query = db.from('inapp_notifications').select('*');
    if (recipient) {
      query = query.eq('recipient', recipient);
    }
    
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. PUT /api/notifications/read - Mark notifications as read
app.put('/api/notifications/read', async (req, res) => {
  const { ids, recipient } = req.body;

  try {
    let query = db.from('inapp_notifications').update({ is_read: 1 });

    if (ids && Array.isArray(ids)) {
      query = query.in('id', ids);
    } else if (recipient) {
      query = query.eq('recipient', recipient);
    } else {
      return res.status(400).json({ error: "Укажите ids или recipient для пометки прочитанным." });
    }

    const { error } = await query;
    if (error) throw error;
    res.json({ success: true, message: "Уведомления помечены как прочитанные." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. GET /api/settings - Get settings (with masked passwords)
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  const masked = { ...settings };
  if (masked.smtp_pass) masked.smtp_pass = '••••••••';
  if (masked.rocketchat_token) masked.rocketchat_token = '••••••••';
  res.json(masked);
});

// 9. PUT /api/settings - Update settings
app.put('/api/settings', (req, res) => {
  const success = saveSettings(req.body);
  if (success) {
    res.json({ success: true, message: "Настройки успешно сохранены." });
  } else {
    res.status(500).json({ error: "Не удалось сохранить настройки в settings.json" });
  }
});

// 10. POST /api/settings/test - Test connection using current form configuration
app.post('/api/settings/test', async (req, res) => {
  const currentSettings = getSettings();
  const testSettings = { ...req.body };
  
  // Resolve masked values
  if (testSettings.smtp_pass === '••••••••') {
    testSettings.smtp_pass = currentSettings.smtp_pass;
  }
  if (testSettings.rocketchat_token === '••••••••') {
    testSettings.rocketchat_token = currentSettings.rocketchat_token;
  }

  const logs = [];
  let emailSuccess = true;
  let rcSuccess = true;
  let errorMsg = "";

  // 1. Test Email if SMTP is configured
  if (testSettings.smtp_host && testSettings.smtp_user) {
    try {
      logs.push("⏳ Тестирование Email...");
      const emailHtml = `
        <h2>Тестовое оповещение Refund Manager</h2>
        <p>Настройки SMTP введены корректно! Соединение установлено.</p>
        <p>Дата теста: ${new Date().toLocaleString('ru-RU')}</p>
      `;
      await sendEmailNotification(testSettings.smtp_user, "Тестовое оповещение", emailHtml, testSettings);
      logs.push("✅ Email отправлен успешно на " + testSettings.smtp_user);
    } catch (e) {
      emailSuccess = false;
      errorMsg += `Ошибка SMTP: ${e.message}. `;
      logs.push("❌ Ошибка Email: " + e.message);
    }
  } else {
    logs.push("ℹ️ SMTP не настроен, пропуск теста Email.");
  }

  // 2. Test Rocket Chat if configured
  if (testSettings.rocketchat_url) {
    try {
      logs.push("⏳ Тестирование Rocket Chat...");
      const msg = `🧪 *Тестовый алерт Refund Manager!*\nНастройки Rocket Chat введены верно. Тест пройден успешно!`;
      
      await sendRocketChatNotification(msg, null, testSettings);
      logs.push("✅ Сообщение в Rocket Chat отправлено успешно.");
    } catch (e) {
      rcSuccess = false;
      errorMsg += `Ошибка Rocket Chat: ${e.message}. `;
      logs.push("❌ Ошибка Rocket Chat: " + e.message);
    }
  } else {
    logs.push("ℹ️ Rocket Chat не настроен, пропуск теста чата.");
  }

  const overallSuccess = emailSuccess && rcSuccess;
  res.json({
    success: overallSuccess,
    logs,
    error: overallSuccess ? null : errorMsg.trim()
  });
});

// Dynamic Validators API endpoints
app.get('/api/validators', async (req, res) => {
  try {
    const list = await getValidatorsFromDb();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/validators', async (req, res) => {
  const { code } = req.body;
  if (!code || !code.trim()) {
    return res.status(400).json({ error: "Код валидатора пуст." });
  }
  const cleanCode = code.trim().toUpperCase();

  try {
    const { error } = await db
      .from('validators')
      .insert([{ code: cleanCode }]);

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: `Валидатор ${cleanCode} уже существует.` });
      }
      throw error;
    }
    res.status(201).json({ success: true, code: cleanCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/validators/:code', async (req, res) => {
  const { code } = req.params;
  const cleanCode = code.trim().toUpperCase();

  try {
    const { error } = await db
      .from('validators')
      .delete()
      .eq('code', cleanCode);
      
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all route to serve the React frontend for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server after initializing database connection
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Refund Applications API Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ Database initialization failed:", err);
    process.exit(1);
  });
