import React, { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

const CURRENCIES = ['EUR', 'USD', 'RUB', 'TRY', 'KGS', 'KZT'];
const AGENTS = [
  "Emerging Travel Inc. (0CK9)",
  "Alfa Travel LLC (1AB2)",
  "Ticket.ru (5XY8)",
  "Siberia Agency (9ZZ1)",
  "Aeroflot Agent (2CD3)"
];
const STATUSES = ["Создан", "На проверке", "Авторизовано", "авторизовано с расхождением", "Отклонено"];

// Custom styled Combobox for Validator selection
function ValidatorInput({ value, onChange, options }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState(value);

  useEffect(() => {
    setSearchTerm(value);
  }, [value]);

  const filtered = options.filter(opt =>
    opt.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        type="text"
        className="input-field"
        placeholder="Введите или выберите (например: SU)"
        value={searchTerm}
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          setTimeout(() => setIsOpen(false), 200);
        }}
        onChange={(e) => {
          const val = e.target.value.toUpperCase();
          setSearchTerm(val);
          onChange(val);
        }}
      />
      {isOpen && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--border-radius-sm)',
          maxHeight: '180px',
          overflowY: 'auto',
          zIndex: 1000,
          marginTop: '4px',
          boxShadow: 'var(--box-shadow-md)',
          padding: '4px 0'
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '0.75rem 1rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              Нет совпадений (нажмите Enter для сохранения)
            </div>
          ) : (
            filtered.map(opt => (
              <div
                key={opt}
                style={{
                  padding: '0.6rem 1rem',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  transition: 'background 0.15s ease'
                }}
                onMouseDown={() => {
                  onChange(opt);
                  setSearchTerm(opt);
                }}
                onMouseEnter={(e) => e.target.style.backgroundColor = 'var(--bg-hover)'}
                onMouseLeave={(e) => e.target.style.backgroundColor = 'transparent'}
              >
                {opt}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  // Core Data State
  const [refunds, setRefunds] = useState([]);
  const [stats, setStats] = useState({
    totalPending: 0,
    authorizedSums: [], // array of {currency, sum}
    activeWarningsCount: 0,
    totalCreated: 0
  });

  // Dynamic Validators List
  const [validators, setValidators] = useState([]);

  // Notifications (Global activity)
  const [notifications, setNotifications] = useState([]);
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);

  // Filters State
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [systemFilter, setSystemFilter] = useState('');
  const [validatorFilter, setValidatorFilter] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [onlyWarningsFilter, setOnlyWarningsFilter] = useState(false);
  const [onlyPendingFilter, setOnlyPendingFilter] = useState(false);

  // Pagination State
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const limit = 10;

  // Modals visibility
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  
  // Admin & Settings State
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState('integration'); // 'integration' | 'validators'
  const [adminPassword, setAdminPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [newValidatorCode, setNewValidatorCode] = useState('');
  const [validatorError, setValidatorError] = useState('');

  const [settingsForm, setSettingsForm] = useState({
    smtp_host: '',
    smtp_port: '587',
    smtp_secure: false,
    smtp_user: '',
    smtp_pass: '',
    smtp_from: '',
    rocketchat_url: '',
    rocketchat_token: '',
    rocketchat_user: '',
    rocketchat_channel: '#refund-alerts',
    google_sheets_webhook: ''
  });
  const [testLogs, setTestLogs] = useState([]);
  const [testing, setTesting] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState({ type: '', text: '' });

  // Active items
  const [activeRefund, setActiveRefund] = useState(null);
  const [history, setHistory] = useState([]);
  const [formErrors, setFormErrors] = useState({});

  const [formData, setFormData] = useState({
    ticket_number: '',
    bsp_request_number: '',
    tch_request_number: '',
    system_type: 'BSP Link',
    validator: 'SU',
    request_date: new Date().toISOString().split('T')[0],
    amount_eur: '', // maps to amount
    currency: 'EUR',
    agent_refund_equivalent: '',
    agent_name: '',
    requested_by: '',
    operator_email: '',
    operator_rocketchat: '',
    comment: ''
  });

  const [statusData, setStatusData] = useState({
    new_status: 'На проверке',
    comment: '',
    changed_by: 'СОФИ',
    authorized_amount: ''
  });

  // Effects
  useEffect(() => {
    fetchRefunds();
    fetchStats();
  }, [page, search, statusFilter, systemFilter, validatorFilter, dateStart, dateEnd, onlyWarningsFilter, onlyPendingFilter]);

  useEffect(() => {
    fetchNotifications();
    fetchValidators();
  }, []);

  // API calls
  const fetchRefunds = async () => {
    try {
      const query = new URLSearchParams({
        page,
        limit,
        search,
        status: statusFilter,
        system_type: systemFilter,
        validator: validatorFilter,
        date_start: dateStart,
        date_end: dateEnd,
        only_warnings: onlyWarningsFilter ? 'true' : 'false',
        only_pending: onlyPendingFilter ? 'true' : 'false'
      });
      const res = await fetch(`${API_BASE}/refunds?${query}`);
      const data = await res.json();
      if (res.ok) {
        setRefunds(data.data);
        setTotalPages(data.pagination.totalPages);
      }
    } catch (err) {
      console.error("Error fetching refunds:", err);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/refunds/stats`);
      const data = await res.json();
      if (res.ok) {
        setStats(data);
      }
    } catch (err) {
      console.error("Error fetching stats:", err);
    }
  };

  const fetchValidators = async () => {
    try {
      const res = await fetch(`${API_BASE}/validators`);
      const data = await res.json();
      if (res.ok) {
        setValidators(data);
      }
    } catch (err) {
      console.error("Error fetching validators:", err);
    }
  };

  const fetchNotifications = async () => {
    try {
      const res = await fetch(`${API_BASE}/notifications`);
      const data = await res.json();
      if (res.ok) {
        setNotifications(data);
      }
    } catch (err) {
      console.error("Error fetching notifications:", err);
    }
  };

  const markNotificationsRead = async () => {
    try {
      const unreadIds = notifications.filter(n => n.is_read === 0).map(n => n.id);
      if (unreadIds.length === 0) return;

      const res = await fetch(`${API_BASE}/notifications/read`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: unreadIds })
      });
      if (res.ok) {
        fetchNotifications();
      }
    } catch (err) {
      console.error("Error marking notifications read:", err);
    }
  };

  const handleCreateRefund = async (e) => {
    e.preventDefault();
    const errors = {};
    if (!formData.ticket_number || formData.ticket_number.length !== 13 || isNaN(formData.ticket_number)) {
      errors.ticket_number = 'Номер билета должен состоять ровно из 13 цифр.';
    }
    if (formData.system_type === 'BSP Link' && !formData.bsp_request_number.trim()) {
      errors.bsp_request_number = 'Номер запроса BSP Link обязателен.';
    }
    if (formData.system_type === 'TCH Connect' && !formData.tch_request_number.trim()) {
      errors.tch_request_number = 'Номер запроса TCH Connect обязателен.';
    }
    if (!formData.amount_eur || isNaN(formData.amount_eur) || parseFloat(formData.amount_eur) <= 0) {
      errors.amount_eur = 'Укажите корректную сумму к возврату (> 0).';
    }
    if (formData.agent_refund_equivalent && isNaN(formData.agent_refund_equivalent)) {
      errors.agent_refund_equivalent = 'Должно быть числом.';
    }
    if (!formData.agent_name.trim()) {
      errors.agent_name = 'Укажите агента получателя.';
    }
    if (!formData.requested_by.trim()) {
      errors.requested_by = 'Укажите имя оператора.';
    }
    if (!formData.operator_rocketchat.trim()) {
      errors.operator_rocketchat = 'Username в Rocket Chat обязателен.';
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    const payload = {
      ...formData,
      bsp_request_number: formData.system_type === 'BSP Link' ? formData.bsp_request_number : null,
      tch_request_number: formData.system_type === 'TCH Connect' ? formData.tch_request_number : null
    };

    try {
      const res = await fetch(`${API_BASE}/refunds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        setShowAddModal(false);
        setFormData({
          ticket_number: '',
          bsp_request_number: '',
          tch_request_number: '',
          system_type: 'BSP Link',
          validator: validators[0] || 'SU',
          request_date: new Date().toISOString().split('T')[0],
          amount_eur: '',
          currency: 'EUR',
          agent_refund_equivalent: '',
          agent_name: '',
          requested_by: '',
          operator_email: '',
          operator_rocketchat: '',
          comment: ''
        });
        setFormErrors({});
        fetchRefunds();
        fetchStats();
        fetchNotifications();
      } else {
        setFormErrors({ server: data.error });
      }
    } catch (err) {
      console.error("Error creating refund:", err);
    }
  };

  const handleUpdateStatus = async (e) => {
    e.preventDefault();
    if (statusData.new_status === 'авторизовано с расхождением' && (!statusData.authorized_amount || isNaN(statusData.authorized_amount) || parseFloat(statusData.authorized_amount) <= 0)) {
      alert("Пожалуйста, укажите корректную авторизованную сумму.");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/refunds/${activeRefund.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(statusData)
      });
      if (res.ok) {
        setShowStatusModal(false);
        setStatusData({ new_status: 'На проверке', comment: '', changed_by: 'СОФИ', authorized_amount: '' });
        fetchRefunds();
        fetchStats();
        fetchNotifications();
      }
    } catch (err) {
      console.error("Error updating status:", err);
    }
  };

  const viewHistory = async (refund) => {
    setActiveRefund(refund);
    try {
      const res = await fetch(`${API_BASE}/refunds/${refund.id}/history`);
      const data = await res.json();
      if (res.ok) {
        setHistory(data);
        setShowHistoryModal(true);
      }
    } catch (err) {
      console.error("Error fetching history:", err);
    }
  };

  const handleEditClick = (refund) => {
    setActiveRefund(refund);
    setFormData({
      ticket_number: refund.ticket_number,
      bsp_request_number: refund.bsp_request_number || '',
      tch_request_number: refund.tch_request_number || '',
      system_type: refund.system_type,
      validator: refund.validator,
      request_date: refund.request_date,
      amount_eur: String(refund.amount),
      currency: refund.currency,
      agent_refund_equivalent: refund.agent_refund_equivalent ? String(refund.agent_refund_equivalent) : '',
      agent_name: refund.agent_name,
      requested_by: refund.requested_by,
      operator_email: refund.operator_email || '',
      operator_rocketchat: refund.operator_rocketchat || '',
      comment: ''
    });
    setFormErrors({});
    setShowEditModal(true);
  };

  const handleEditRefund = async (e) => {
    e.preventDefault();
    const errors = {};
    if (!formData.ticket_number || formData.ticket_number.length !== 13 || isNaN(formData.ticket_number)) {
      errors.ticket_number = 'Номер билета должен состоять ровно из 13 цифр.';
    }
    if (formData.system_type === 'BSP Link' && !formData.bsp_request_number.trim()) {
      errors.bsp_request_number = 'Номер запроса BSP Link обязателен.';
    }
    if (formData.system_type === 'TCH Connect' && !formData.tch_request_number.trim()) {
      errors.tch_request_number = 'Номер запроса TCH Connect обязателен.';
    }
    if (!formData.amount_eur || isNaN(formData.amount_eur) || parseFloat(formData.amount_eur) <= 0) {
      errors.amount_eur = 'Укажите корректную сумму к возврату (> 0).';
    }
    if (formData.agent_refund_equivalent && isNaN(formData.agent_refund_equivalent)) {
      errors.agent_refund_equivalent = 'Должно быть числом.';
    }
    if (!formData.agent_name.trim()) {
      errors.agent_name = 'Укажите агента получателя.';
    }
    if (!formData.requested_by.trim()) {
      errors.requested_by = 'Укажите имя оператора.';
    }
    if (!formData.operator_rocketchat.trim()) {
      errors.operator_rocketchat = 'Username в Rocket Chat обязателен.';
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    const payload = {
      ...formData,
      bsp_request_number: formData.system_type === 'BSP Link' ? formData.bsp_request_number : null,
      tch_request_number: formData.system_type === 'TCH Connect' ? formData.tch_request_number : null
    };

    try {
      const res = await fetch(`${API_BASE}/refunds/${activeRefund.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        setShowEditModal(false);
        setFormData({
          ticket_number: '',
          bsp_request_number: '',
          tch_request_number: '',
          system_type: 'BSP Link',
          validator: validators[0] || 'SU',
          request_date: new Date().toISOString().split('T')[0],
          amount_eur: '',
          currency: 'EUR',
          agent_refund_equivalent: '',
          agent_name: '',
          requested_by: '',
          operator_email: '',
          operator_rocketchat: '',
          comment: ''
        });
        setFormErrors({});
        fetchRefunds();
        fetchStats();
      } else {
        setFormErrors({ server: data.error });
      }
    } catch (err) {
      console.error("Error editing refund:", err);
    }
  };

  const handleDeleteClick = async (refund) => {
    if (!confirm(`Вы действительно хотите удалить заявку по билету ${refund.ticket_number}?`)) return;
    try {
      const res = await fetch(`${API_BASE}/refunds/${refund.id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchRefunds();
        fetchStats();
      } else {
        const data = await res.json();
        alert(`Ошибка при удалении: ${data.error}`);
      }
    } catch (err) {
      console.error("Error deleting refund:", err);
    }
  };

  const openStatusModal = (refund) => {
    setActiveRefund(refund);
    setStatusData({
      new_status: refund.status === 'Создан' ? 'На проверке' : 'Авторизовано',
      comment: '',
      changed_by: 'СОФИ',
      authorized_amount: refund.status === 'авторизовано с расхождением' ? String(refund.authorized_amount) : ''
    });
    setShowStatusModal(true);
  };

  const toggleWarningsFilter = () => {
    setOnlyPendingFilter(false);
    setStatusFilter('');
    setOnlyWarningsFilter(!onlyWarningsFilter);
    setPage(1);
  };

  const togglePendingFilter = () => {
    setOnlyWarningsFilter(false);
    setStatusFilter('');
    setOnlyPendingFilter(!onlyPendingFilter);
    setPage(1);
  };

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('');
    setSystemFilter('');
    setValidatorFilter('');
    setDateStart('');
    setDateEnd('');
    setOnlyWarningsFilter(false);
    setOnlyPendingFilter(false);
    setPage(1);
  };

  // Admin panel actions
  const handleAdminLogin = (e) => {
    e.preventDefault();
    if (adminPassword === 'admin') {
      setLoginError('');
      setAdminPassword('');
      setShowLoginModal(false);
      setSettingsTab('integration');
      loadSettings();
    } else {
      setLoginError('Неверный пароль администратора.');
    }
  };

  const loadSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      const data = await res.json();
      if (res.ok) {
        setSettingsForm(data);
        setTestLogs([]);
        setSettingsMessage({ type: '', text: '' });
        setShowSettingsModal(true);
      }
    } catch (err) {
      console.error("Error loading settings:", err);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm)
      });
      if (res.ok) {
        setSettingsMessage({ type: 'success', text: 'Настройки успешно сохранены!' });
        setTimeout(() => setShowSettingsModal(false), 1500);
      } else {
        setSettingsMessage({ type: 'error', text: 'Ошибка при сохранении настроек.' });
      }
    } catch (err) {
      console.error("Error saving settings:", err);
      setSettingsMessage({ type: 'error', text: 'Ошибка сети при сохранении настроек.' });
    }
  };

  const handleTestSettings = async () => {
    setTesting(true);
    setTestLogs(["🔄 Инициализация тестирования..."]);
    try {
      const res = await fetch(`${API_BASE}/settings/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm)
      });
      const data = await res.json();
      if (res.ok) {
        setTestLogs(data.logs);
      } else {
        setTestLogs(prev => [...prev, "❌ Ошибка тестирования: " + data.error]);
      }
    } catch (err) {
      setTestLogs(prev => [...prev, "❌ Ошибка сети при соединении с сервером."]);
    } finally {
      setTesting(false);
    }
  };

  // Add validator dynamically
  const handleAddValidator = async (e) => {
    e.preventDefault();
    if (!newValidatorCode.trim()) return;
    setValidatorError('');
    try {
      const res = await fetch(`${API_BASE}/validators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: newValidatorCode.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setNewValidatorCode('');
        fetchValidators();
      } else {
        setValidatorError(data.error);
      }
    } catch (err) {
      setValidatorError("Ошибка сети при добавлении валидатора.");
    }
  };

  // Delete validator dynamically
  const handleDeleteValidator = async (code) => {
    if (!confirm(`Удалить валидатор ${code}?`)) return;
    try {
      const res = await fetch(`${API_BASE}/validators/${code}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchValidators();
      }
    } catch (err) {
      console.error("Error deleting validator:", err);
    }
  };

  // Format statistics authorized values
  const renderAuthorizedSums = () => {
    if (!stats || !stats.authorizedSums || stats.authorizedSums.length === 0) {
      return <div style={{ fontSize: '1.25rem', color: 'var(--text-muted)' }}>0.00 EUR</div>;
    }
    return (
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
        {stats.authorizedSums.map(item => {
          let symbol = item.currency;
          if (item.currency === 'EUR') symbol = '€';
          else if (item.currency === 'USD') symbol = '$';
          else if (item.currency === 'RUB') symbol = 'руб.';
          
          const formattedSum = item.sum.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
          return (
            <span 
              key={item.currency} 
              style={{
                padding: '0.2rem 0.5rem',
                background: 'rgba(99, 102, 241, 0.15)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                borderRadius: '4px',
                fontSize: '0.9rem',
                fontWeight: '600',
                color: '#a5b4fc',
                whiteSpace: 'nowrap'
              }}
            >
              {formattedSum} {symbol}
            </span>
          );
        })}
      </div>
    );
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case 'Создан': return 'badge-status-created';
      case 'На проверке': return 'badge-status-review';
      case 'Авторизовано': return 'badge-status-authorized';
      case 'авторизовано с расхождением': return 'badge-status-discrepancy';
      case 'Отклонено': return 'badge-status-rejected';
      default: return '';
    }
  };

  const isTicketWarning = (refund) => {
    if (refund.status === 'Авторизовано' || refund.status === 'Отклонено' || refund.status === 'авторизовано с расхождением') return false;
    const updated = new Date(refund.status_updated_at);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    return updated <= ninetyDaysAgo;
  };

  const unreadCount = notifications.filter(n => n.is_read === 0).length;

  return (
    <div className="app-container">
      {/* HEADER */}
      <header className="app-header">
        <div className="logo-container">
          <h1>Менеджер возвратов BSP Link / TCH Connect</h1>
          <p>Панель управления Refund Application и автоматическим контролем простоя</p>
        </div>
        
        <div className="header-actions">
          {/* Admin Panel Gear Button */}
          <button 
            className="bell-button" 
            title="Настройки оповещений и справочников (Админка)"
            onClick={() => setShowLoginModal(true)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          {/* Bell Icon Notification dropdown */}
          <div className="bell-container">
            <button className="bell-button" onClick={() => {
              setShowNotifDropdown(!showNotifDropdown);
              if (!showNotifDropdown) markNotificationsRead();
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unreadCount > 0 && <span className="bell-badge">{unreadCount}</span>}
            </button>

            {showNotifDropdown && (
              <div className="bell-dropdown">
                <div className="dropdown-header">
                  <h3>Журнал событий (оповещения)</h3>
                  <button className="mark-read-btn" onClick={markNotificationsRead}>Прочитано</button>
                </div>
                <div className="notification-list">
                  {notifications.length === 0 ? (
                    <div className="no-notifications">Уведомлений нет</div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} className={`notification-item ${n.is_read === 0 ? 'unread' : ''}`}>
                        <div className="notification-msg">
                          Билет <span className="notification-ticket">{n.ticket_number}</span>: {n.message}
                        </div>
                        <div className="notification-time">{new Date(n.created_at).toLocaleString('ru-RU')}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* DASHBOARD STATS */}
      <section className="stats-grid">
        <div 
          className="stat-card pending-card"
          style={{ 
            cursor: 'pointer',
            border: onlyPendingFilter ? '2px solid var(--accent-color)' : '1px solid var(--border-color)',
            boxShadow: onlyPendingFilter ? '0 0 15px rgba(99, 102, 241, 0.25)' : 'var(--box-shadow-sm)',
            transform: onlyPendingFilter ? 'translateY(-2px)' : 'none'
          }}
          onClick={togglePendingFilter}
          title="Нажмите, чтобы отфильтровать таблицу по заявкам в обработке"
        >
          <span className="stat-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            В обработке
            {onlyPendingFilter && <span style={{ fontSize: '0.7rem', color: 'var(--accent-color)', fontWeight: 'bold' }}>ФИЛЬТР АКТИВЕН</span>}
          </span>
          <span className="stat-value">{stats.totalPending}</span>
        </div>
        <div className="stat-card">
          <span className="stat-title">Авторизовано (по валютам)</span>
          <div className="stat-value" style={{ display: 'flex', wordBreak: 'break-all', fontSize: '1.5rem' }}>{renderAuthorizedSums()}</div>
        </div>
        
        {/* Clickable stat card for Warnings */}
        <div 
          className={`stat-card warning-card ${stats.activeWarningsCount > 0 ? 'has-warnings' : ''}`}
          style={{ 
            cursor: 'pointer',
            border: onlyWarningsFilter ? '2px solid var(--warning-text)' : '1px solid var(--border-color)',
            boxShadow: onlyWarningsFilter ? '0 0 15px rgba(239, 68, 68, 0.25)' : 'var(--box-shadow-sm)',
            transform: onlyWarningsFilter ? 'translateY(-2px)' : 'none'
          }}
          onClick={toggleWarningsFilter}
          title="Нажмите, чтобы отфильтровать таблицу по зависшим заявкам"
        >
          <span className="stat-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            Простой без движения (&gt;3 мес)
            {onlyWarningsFilter && <span style={{ fontSize: '0.7rem', color: 'var(--warning-text)', fontWeight: 'bold' }}>ФИЛЬТР АКТИВЕН</span>}
          </span>
          <span className="stat-value">{stats.activeWarningsCount}</span>
        </div>
        
        <div className="stat-card">
          <span className="stat-title">Всего запросов</span>
          <span className="stat-value">{stats.totalCreated}</span>
        </div>
      </section>

      {/* SEARCH AND FILTERS */}
      <section className="filters-panel">
        <div className="filters-grid">
          <div className="filter-group full-width" style={{ gridColumn: 'span 2' }}>
            <label>Поиск по билету, агенту или оператору</label>
            <input 
              type="text" 
              className="input-field" 
              placeholder="Введите номер билета, RA, название агента..." 
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>

          <div className="filter-group">
            <label>Статус</label>
            <select className="select-field" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
              <option value="">Все статусы</option>
              {STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
          </div>

          <div className="filter-group">
            <label>Система</label>
            <select className="select-field" value={systemFilter} onChange={(e) => { setSystemFilter(e.target.value); setPage(1); }}>
              <option value="">Все подключения</option>
              <option value="BSP Link">BSP Link</option>
              <option value="TCH Connect">TCH Connect</option>
            </select>
          </div>

          <div className="filter-group">
            <label>Валидатор</label>
            <select className="select-field" value={validatorFilter} onChange={(e) => { setValidatorFilter(e.target.value); setPage(1); }}>
              <option value="">Все валидаторы</option>
              {validators.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="filter-group">
            <label>Дата начала</label>
            <input type="date" className="input-field" value={dateStart} onChange={(e) => { setDateStart(e.target.value); setPage(1); }} />
          </div>

          <div className="filter-group">
            <label>Дата конца</label>
            <input type="date" className="input-field" value={dateEnd} onChange={(e) => { setDateEnd(e.target.value); setPage(1); }} />
          </div>

          <div className="filters-actions">
            <button className="btn btn-secondary" onClick={clearFilters}>Сбросить</button>
          </div>
        </div>
      </section>

      {/* REFUNDS DATA GRID */}
      <section className="data-section">
        <div className="table-header-row">
          <h2>Список заявок на возврат</h2>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Создать заявку
          </button>
        </div>

        <div className="table-wrapper">
          <table className="refunds-table">
            <thead>
              <tr>
                <th>Билет</th>
                <th>Подключение</th>
                <th>Запрос BSP / TCH</th>
                <th>Дата создания</th>
                <th>Сумма к возврату</th>
                <th>Эквивалент</th>
                <th>Агент получатель</th>
                <th>Создал</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {refunds.length === 0 ? (
                <tr>
                  <td colSpan="10" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                    Заявки не найдены. Измените параметры фильтрации или создайте новую заявку.
                  </td>
                </tr>
              ) : (
                refunds.map(refund => {
                  const isWarning = isTicketWarning(refund);
                  const isDiscrepancy = refund.status === 'авторизовано с расхождением';
                  return (
                    <tr key={refund.id} className={isWarning ? 'warning-row' : ''}>
                      <td style={{ fontWeight: '600' }}>
                        {refund.ticket_number}
                        {isWarning && (
                          <div className="warning-label" title="Статус не менялся более 90 дней">
                            ⚠️ Простой {Math.floor((new Date() - new Date(refund.status_updated_at)) / (1000 * 60 * 60 * 24))} дн.
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="badge badge-system">{refund.system_type} ({refund.validator})</span>
                      </td>
                      <td>
                        <div style={{ fontSize: '0.8125rem' }}>
                          {refund.bsp_request_number && <div>BSP: {refund.bsp_request_number}</div>}
                          {refund.tch_request_number && <div>TCH: {refund.tch_request_number}</div>}
                          {!refund.bsp_request_number && !refund.tch_request_number && <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </div>
                      </td>
                      <td>{new Date(refund.request_date).toLocaleDateString('ru-RU')}</td>
                      <td style={{ fontWeight: '500' }}>
                        {isDiscrepancy ? (
                          <div>
                            <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', fontSize: '0.8125rem', marginRight: '0.25rem' }}>
                              {refund.amount} {refund.currency}
                            </span>
                            <div style={{ color: '#22d3ee', fontWeight: 'bold' }}>
                              факт: {refund.authorized_amount} {refund.currency}
                            </div>
                          </div>
                        ) : (
                          `${refund.amount} ${refund.currency}`
                        )}
                      </td>
                      <td>
                        {refund.agent_refund_equivalent 
                          ? `${refund.agent_refund_equivalent.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} руб.`
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        <div style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={refund.agent_name}>
                          {refund.agent_name}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: '0.875rem' }}>{refund.requested_by}</div>
                        {(refund.operator_email || refund.operator_rocketchat) && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {refund.operator_email && <div style={{ textOverflow: 'ellipsis', overflow: 'hidden', maxWidth: '120px' }}>✉️ {refund.operator_email}</div>}
                            {refund.operator_rocketchat && <div>💬 {refund.operator_rocketchat}</div>}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge badge-status ${getStatusBadgeClass(refund.status)}`}>
                          {refund.status}
                        </span>
                      </td>
                      <td>
                        <div className="actions-cell">
                          <button 
                            className="btn-icon" 
                            title="Изменить статус (СОФИ)"
                            onClick={() => openStatusModal(refund)}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M20 11.08V12a8 8 0 1 1-4.8-7.32" />
                              <polyline points="22 4 12 14.01 9 11.01" />
                            </svg>
                          </button>
                          <button 
                            className="btn-icon edit-action" 
                            title="Редактировать параметры"
                            onClick={() => handleEditClick(refund)}
                            style={{ color: '#fbbf24' }}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                            </svg>
                          </button>
                          <button 
                            className="btn-icon delete-action" 
                            title="Удалить заявку"
                            onClick={() => handleDeleteClick(refund)}
                            style={{ color: '#ef4444' }}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                              <line x1="10" y1="11" x2="10" y2="17"/>
                              <line x1="14" y1="11" x2="14" y2="17"/>
                            </svg>
                          </button>
                          <button 
                            className="btn-icon info-action" 
                            title="История изменений"
                            onClick={() => viewHistory(refund)}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <polyline points="12 6 12 12 16 14" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* PAGINATION FOOTER */}
        {totalPages > 1 && (
          <div className="pagination-footer">
            <span className="pagination-info">
              Страница {page} из {totalPages}
            </span>
            <div className="pagination-controls">
              <button 
                className="btn btn-secondary" 
                style={{ padding: '0.4rem 0.8rem' }}
                disabled={page === 1} 
                onClick={() => setPage(page - 1)}
              >
                Назад
              </button>
              {Array.from({ length: totalPages }).map((_, idx) => (
                <span 
                  key={idx} 
                  className={`page-num ${page === idx + 1 ? 'active' : ''}`}
                  onClick={() => setPage(idx + 1)}
                >
                  {idx + 1}
                </span>
              ))}
              <button 
                className="btn btn-secondary" 
                style={{ padding: '0.4rem 0.8rem' }}
                disabled={page === totalPages} 
                onClick={() => setPage(page + 1)}
              >
                Вперед
              </button>
            </div>
          </div>
        )}
      </section>

      {/* CREATE REFUND MODAL */}
      {showAddModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Создать заявку на возврат</h2>
              <button className="btn-icon" onClick={() => { setShowAddModal(false); setFormErrors({}); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleCreateRefund}>
              <div className="modal-body form-grid">
                {formErrors.server && <div className="full-width field-error" style={{ fontSize: '0.9rem', background: 'var(--warning-bg)', padding: '0.75rem', borderRadius: '6px' }}>{formErrors.server}</div>}
                
                <div className="full-width">
                  <label>Номер тикета (13 цифр) *</label>
                  <input 
                    type="text" 
                    maxLength="13"
                    className="input-field" 
                    placeholder="Например: 6339413054870"
                    value={formData.ticket_number}
                    onChange={(e) => setFormData({ ...formData, ticket_number: e.target.value.replace(/\D/g, '') })}
                  />
                  {formErrors.ticket_number && <span className="field-error">{formErrors.ticket_number}</span>}
                </div>

                <div>
                  <label>Система *</label>
                  <select 
                    className="select-field" 
                    value={formData.system_type}
                    onChange={(e) => setFormData({ ...formData, system_type: e.target.value })}
                  >
                    <option value="BSP Link">BSP Link</option>
                    <option value="TCH Connect">TCH Connect</option>
                  </select>
                </div>

                <div>
                  <label>Валидатор *</label>
                  <ValidatorInput 
                    value={formData.validator}
                    onChange={(val) => setFormData({ ...formData, validator: val })}
                    options={validators}
                  />
                </div>

                {formData.system_type === 'BSP Link' ? (
                  <div className="full-width">
                    <label>Номер запроса BSP Link *</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Например: 1013434733"
                      value={formData.bsp_request_number}
                      onChange={(e) => setFormData({ ...formData, bsp_request_number: e.target.value.replace(/\D/g, '') })}
                    />
                    {formErrors.bsp_request_number && <span className="field-error">{formErrors.bsp_request_number}</span>}
                  </div>
                ) : (
                  <div className="full-width">
                    <label>Номер запроса TCH Connect *</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Например: 4001971457"
                      value={formData.tch_request_number}
                      onChange={(e) => setFormData({ ...formData, tch_request_number: e.target.value.replace(/\D/g, '') })}
                    />
                    {formErrors.tch_request_number && <span className="field-error">{formErrors.tch_request_number}</span>}
                  </div>
                )}

                <div>
                  <label>Сумма к возврату ({formData.currency}) *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: 205.44"
                    value={formData.amount_eur}
                    onChange={(e) => setFormData({ ...formData, amount_eur: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                  {formErrors.amount_eur && <span className="field-error">{formErrors.amount_eur}</span>}
                </div>

                <div>
                  <label>Валюта *</label>
                  <select 
                    className="select-field" 
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  >
                    {CURRENCIES.map(curr => <option key={curr} value={curr}>{curr}</option>)}
                  </select>
                </div>

                <div>
                  <label>Эквивалент для агента (руб.)</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Необязательно"
                    value={formData.agent_refund_equivalent}
                    onChange={(e) => setFormData({ ...formData, agent_refund_equivalent: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                  {formErrors.agent_refund_equivalent && <span className="field-error">{formErrors.agent_refund_equivalent}</span>}
                </div>

                <div>
                  <label>Дата создания запроса (по умолчанию сегодня) *</label>
                  <input 
                    type="date" 
                    className="input-field" 
                    value={formData.request_date}
                    onChange={(e) => setFormData({ ...formData, request_date: e.target.value })}
                  />
                </div>

                <div className="full-width">
                  <label>Агент получатель *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: Emerging Travel Inc. (0CK9)"
                    value={formData.agent_name}
                    onChange={(e) => setFormData({ ...formData, agent_name: e.target.value })}
                  />
                  {formErrors.agent_name && <span className="field-error">{formErrors.agent_name}</span>}
                </div>

                <div>
                  <label>Кем запрошено (ФИО оператора) *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: Гончарова О."
                    value={formData.requested_by} 
                    onChange={(e) => setFormData({ ...formData, requested_by: e.target.value })} 
                  />
                  {formErrors.requested_by && <span className="field-error">{formErrors.requested_by}</span>}
                </div>

                <div>
                  <label>Email оператора для отбивок</label>
                  <input 
                    type="email" 
                    className="input-field" 
                    placeholder="operator@corporate.ru"
                    value={formData.operator_email} 
                    onChange={(e) => setFormData({ ...formData, operator_email: e.target.value })} 
                  />
                </div>

                <div className="full-width">
                  <label>Username в Rocket Chat для отбивок *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: @username"
                    value={formData.operator_rocketchat} 
                    onChange={(e) => setFormData({ ...formData, operator_rocketchat: e.target.value })} 
                  />
                  {formErrors.operator_rocketchat && <span className="field-error">{formErrors.operator_rocketchat}</span>}
                </div>

                <div className="full-width">
                  <label>Комментарий к заявке (необязательно)</label>
                  <textarea 
                    className="input-field" 
                    rows="3"
                    style={{ resize: 'vertical' }}
                    placeholder="Например: возврат проводить не нужно, подождать подтверждения..."
                    value={formData.comment} 
                    onChange={(e) => setFormData({ ...formData, comment: e.target.value })} 
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => { setShowAddModal(false); setFormErrors({}); }}>Отмена</button>
                <button type="submit" className="btn btn-primary">Создать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT REFUND MODAL */}
      {showEditModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Редактировать заявку на возврат</h2>
              <button className="btn-icon" onClick={() => { setShowEditModal(false); setFormErrors({}); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleEditRefund}>
              <div className="modal-body form-grid">
                {formErrors.server && <div className="full-width field-error" style={{ fontSize: '0.9rem', background: 'var(--warning-bg)', padding: '0.75rem', borderRadius: '6px' }}>{formErrors.server}</div>}
                
                <div className="full-width">
                  <label>Номер тикета (13 цифр) *</label>
                  <input 
                    type="text" 
                    maxLength="13"
                    className="input-field" 
                    placeholder="Например: 6339413054870"
                    value={formData.ticket_number}
                    onChange={(e) => setFormData({ ...formData, ticket_number: e.target.value.replace(/\D/g, '') })}
                  />
                  {formErrors.ticket_number && <span className="field-error">{formErrors.ticket_number}</span>}
                </div>

                <div>
                  <label>Система *</label>
                  <select 
                    className="select-field" 
                    value={formData.system_type}
                    onChange={(e) => setFormData({ ...formData, system_type: e.target.value })}
                  >
                    <option value="BSP Link">BSP Link</option>
                    <option value="TCH Connect">TCH Connect</option>
                  </select>
                </div>

                <div>
                  <label>Валидатор *</label>
                  <ValidatorInput 
                    value={formData.validator}
                    onChange={(val) => setFormData({ ...formData, validator: val })}
                    options={validators}
                  />
                </div>

                {formData.system_type === 'BSP Link' ? (
                  <div className="full-width">
                    <label>Номер запроса BSP Link *</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Например: 1013434733"
                      value={formData.bsp_request_number}
                      onChange={(e) => setFormData({ ...formData, bsp_request_number: e.target.value.replace(/\D/g, '') })}
                    />
                    {formErrors.bsp_request_number && <span className="field-error">{formErrors.bsp_request_number}</span>}
                  </div>
                ) : (
                  <div className="full-width">
                    <label>Номер запроса TCH Connect *</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Например: 4001971457"
                      value={formData.tch_request_number}
                      onChange={(e) => setFormData({ ...formData, tch_request_number: e.target.value.replace(/\D/g, '') })}
                    />
                    {formErrors.tch_request_number && <span className="field-error">{formErrors.tch_request_number}</span>}
                  </div>
                )}

                <div>
                  <label>Сумма к возврату ({formData.currency}) *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: 205.44"
                    value={formData.amount_eur}
                    onChange={(e) => setFormData({ ...formData, amount_eur: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                  {formErrors.amount_eur && <span className="field-error">{formErrors.amount_eur}</span>}
                </div>

                <div>
                  <label>Валюта *</label>
                  <select 
                    className="select-field" 
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  >
                    {CURRENCIES.map(curr => <option key={curr} value={curr}>{curr}</option>)}
                  </select>
                </div>

                <div>
                  <label>Эквивалент для агента (руб.)</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Необязательно"
                    value={formData.agent_refund_equivalent}
                    onChange={(e) => setFormData({ ...formData, agent_refund_equivalent: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                  {formErrors.agent_refund_equivalent && <span className="field-error">{formErrors.agent_refund_equivalent}</span>}
                </div>

                <div>
                  <label>Дата создания запроса *</label>
                  <input 
                    type="date" 
                    className="input-field" 
                    value={formData.request_date}
                    onChange={(e) => setFormData({ ...formData, request_date: e.target.value })}
                  />
                </div>

                <div className="full-width">
                  <label>Агент получатель *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: Emerging Travel Inc. (0CK9)"
                    value={formData.agent_name}
                    onChange={(e) => setFormData({ ...formData, agent_name: e.target.value })}
                  />
                  {formErrors.agent_name && <span className="field-error">{formErrors.agent_name}</span>}
                </div>

                <div>
                  <label>Кем запрошено (ФИО оператора) *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: Гончарова О."
                    value={formData.requested_by} 
                    onChange={(e) => setFormData({ ...formData, requested_by: e.target.value })} 
                  />
                  {formErrors.requested_by && <span className="field-error">{formErrors.requested_by}</span>}
                </div>

                <div>
                  <label>Email оператора для отбивок</label>
                  <input 
                    type="email" 
                    className="input-field" 
                    placeholder="operator@corporate.ru"
                    value={formData.operator_email} 
                    onChange={(e) => setFormData({ ...formData, operator_email: e.target.value })} 
                  />
                </div>

                <div className="full-width">
                  <label>Username в Rocket Chat для отбивок *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Например: @username"
                    value={formData.operator_rocketchat} 
                    onChange={(e) => setFormData({ ...formData, operator_rocketchat: e.target.value })} 
                  />
                  {formErrors.operator_rocketchat && <span className="field-error">{formErrors.operator_rocketchat}</span>}
                </div>

                <div className="full-width">
                  <label>Комментарий к изменениям (необязательно)</label>
                  <textarea 
                    className="input-field" 
                    rows="3"
                    style={{ resize: 'vertical' }}
                    placeholder="Например: исправление опечатки в сумме..."
                    value={formData.comment} 
                    onChange={(e) => setFormData({ ...formData, comment: e.target.value })} 
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => { setShowEditModal(false); setFormErrors({}); }}>Отмена</button>
                <button type="submit" className="btn btn-primary">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* UPDATE STATUS MODAL */}
      {showStatusModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '500px' }}>
            <div className="modal-header">
              <h2>Изменить статус запроса</h2>
              <button className="btn-icon" onClick={() => setShowStatusModal(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleUpdateStatus}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div style={{ fontSize: '0.9375rem' }}>
                  Изменение статуса для билета: <strong style={{ color: 'var(--accent-color)' }}>{activeRefund?.ticket_number}</strong><br/>
                  Заявлено: <strong>{activeRefund?.amount} {activeRefund?.currency}</strong>
                </div>
                
                <div className="filter-group">
                  <label>Новый статус *</label>
                  <select 
                    className="select-field"
                    value={statusData.new_status}
                    onChange={(e) => setStatusData({ ...statusData, new_status: e.target.value })}
                  >
                    {STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                  </select>
                </div>

                {/* Conditional authorized_amount field */}
                {statusData.new_status === 'авторизовано с расхождением' && (
                  <div className="filter-group">
                    <label>Фактическая авторизованная сумма ({activeRefund?.currency}) *</label>
                    <input 
                      type="text" 
                      className="input-field"
                      placeholder={`Например: ${Math.floor(activeRefund?.amount * 0.9)}`}
                      value={statusData.authorized_amount}
                      onChange={(e) => setStatusData({ ...statusData, authorized_amount: e.target.value.replace(/[^\d.]/g, '') })}
                    />
                  </div>
                )}

                <div className="filter-group">
                  <label>Комментарий к изменению (необязательно)</label>
                  <textarea 
                    className="input-field"
                    rows="3"
                    style={{ resize: 'vertical' }}
                    placeholder="Например: подтверждено в BSP Link, сумма совпадает. Если не заполнять - отправится стандартная отбивка."
                    value={statusData.comment}
                    onChange={(e) => setStatusData({ ...statusData, comment: e.target.value })}
                  />
                </div>

                <div className="filter-group">
                  <label>Кто вносит изменения *</label>
                  <input 
                    type="text" 
                    className="input-field" 
                    value={statusData.changed_by} 
                    onChange={(e) => setStatusData({ ...statusData, changed_by: e.target.value })} 
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowStatusModal(false)}>Отмена</button>
                <button type="submit" className="btn btn-primary">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADMIN LOGIN MODAL */}
      {showLoginModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h2>Панель администратора</h2>
              <button className="btn-icon" onClick={() => { setShowLoginModal(false); setAdminPassword(''); setLoginError(''); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleAdminLogin}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Для входа в настройки интеграций введите пароль администратора.</p>
                <div className="filter-group">
                  <label>Пароль администратора</label>
                  <input 
                    type="password" 
                    className="input-field" 
                    placeholder="Введите пароль (по умолчанию: admin)" 
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                  />
                  {loginError && <span className="field-error">{loginError}</span>}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => { setShowLoginModal(false); setAdminPassword(''); setLoginError(''); }}>Отмена</button>
                <button type="submit" className="btn btn-primary">Войти</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONFIGURATION / SETTINGS MODAL (WITH TABS FOR INTEGRATION AND VALIDATORS) */}
      {showSettingsModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '750px' }}>
            <div className="modal-header">
              <h2>Настройка интеграций и справочников</h2>
              <button className="btn-icon" onClick={() => setShowSettingsModal(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            
            {/* Modal Tabs */}
            <div style={{ 
              display: 'flex', 
              borderBottom: '1px solid var(--border-color)', 
              backgroundColor: 'rgba(0,0,0,0.1)', 
              padding: '0.5rem 1rem 0 1rem' 
            }}>
              <button 
                type="button"
                onClick={() => setSettingsTab('integration')}
                style={{
                  padding: '0.75rem 1.25rem',
                  border: 'none',
                  borderBottom: settingsTab === 'integration' ? '2px solid var(--accent-color)' : '2px solid transparent',
                  background: 'none',
                  color: settingsTab === 'integration' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '0.875rem'
                }}
              >
                ✉️ Настройки оповещений
              </button>
              <button 
                type="button"
                onClick={() => setSettingsTab('validators')}
                style={{
                  padding: '0.75rem 1.25rem',
                  border: 'none',
                  borderBottom: settingsTab === 'validators' ? '2px solid var(--accent-color)' : '2px solid transparent',
                  background: 'none',
                  color: settingsTab === 'validators' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '0.875rem'
                }}
              >
                ✈️ Справочник Валидаторов
              </button>
            </div>

            {/* TAB CONTENT: INTEGRATION */}
            {settingsTab === 'integration' && (
              <form onSubmit={handleSaveSettings}>
                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  
                  {settingsMessage.text && (
                    <div style={{ 
                      padding: '0.75rem 1rem', 
                      borderRadius: '6px', 
                      fontSize: '0.875rem',
                      backgroundColor: settingsMessage.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                      color: settingsMessage.type === 'success' ? '#34d399' : '#f87171',
                      border: `1px solid ${settingsMessage.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
                    }}>
                      {settingsMessage.text}
                    </div>
                  )}

                  <fieldset style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem' }}>
                    <legend style={{ padding: '0 0.5rem', fontSize: '0.8125rem', fontWeight: 'bold', color: 'var(--accent-color)', textTransform: 'uppercase' }}>Настройки Email (SMTP)</legend>
                    <div className="form-grid" style={{ marginTop: '0.5rem' }}>
                      <div>
                        <label>SMTP Сервер</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="mail.corporate.ru" 
                          value={settingsForm.smtp_host}
                          onChange={(e) => setSettingsForm({ ...settingsForm, smtp_host: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Порт SMTP</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="587" 
                          value={settingsForm.smtp_port}
                          onChange={(e) => setSettingsForm({ ...settingsForm, smtp_port: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Email отправителя (From)</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="Refund Manager <bot@corporate.ru>" 
                          value={settingsForm.smtp_from}
                          onChange={(e) => setSettingsForm({ ...settingsForm, smtp_from: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Имя пользователя SMTP</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="bot@corporate.ru" 
                          value={settingsForm.smtp_user}
                          onChange={(e) => setSettingsForm({ ...settingsForm, smtp_user: e.target.value })}
                        />
                      </div>
                      <div className="full-width">
                        <label>Пароль SMTP</label>
                        <input 
                          type="password" 
                          className="input-field" 
                          placeholder="Пароль от почтового ящика" 
                          value={settingsForm.smtp_pass}
                          onChange={(e) => setSettingsForm({ ...settingsForm, smtp_pass: e.target.value })}
                        />
                      </div>
                      <div className="full-width" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          id="smtp_secure"
                          checked={settingsForm.smtp_secure}
                          onChange={(e) => setSettingsForm({ ...settingsForm, smtp_secure: e.target.checked })}
                          style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                        />
                        <label htmlFor="smtp_secure" style={{ cursor: 'pointer' }}>Использовать SSL/TLS (включать для порта 465, выключать для 587/25)</label>
                      </div>
                    </div>
                  </fieldset>

                  <fieldset style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem' }}>
                    <legend style={{ padding: '0 0.5rem', fontSize: '0.8125rem', fontWeight: 'bold', color: 'var(--accent-color)', textTransform: 'uppercase' }}>Настройки Rocket Chat</legend>
                    <div className="form-grid" style={{ marginTop: '0.5rem' }}>
                      <div className="full-width">
                        <label>Rocket Chat URL / Webhook URL</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="https://chat.corporate.ru или ссылка на вебхук" 
                          value={settingsForm.rocketchat_url}
                          onChange={(e) => setSettingsForm({ ...settingsForm, rocketchat_url: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Токен авторизации (REST API)</label>
                        <input 
                          type="password" 
                          className="input-field" 
                          placeholder="Укажите токен доступа" 
                          value={settingsForm.rocketchat_token}
                          onChange={(e) => setSettingsForm({ ...settingsForm, rocketchat_token: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>ID пользователя бота (REST API)</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="User ID бота" 
                          value={settingsForm.rocketchat_user}
                          onChange={(e) => setSettingsForm({ ...settingsForm, rocketchat_user: e.target.value })}
                        />
                      </div>
                      <div className="full-width">
                        <label>Канал Rocket Chat по умолчанию</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="#refund-alerts" 
                          value={settingsForm.rocketchat_channel}
                          onChange={(e) => setSettingsForm({ ...settingsForm, rocketchat_channel: e.target.value })}
                        />
                      </div>
                    </div>
                  </fieldset>

                  <fieldset style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem', marginTop: '1rem' }}>
                    <legend style={{ padding: '0 0.5rem', fontSize: '0.8125rem', fontWeight: 'bold', color: 'var(--accent-color)', textTransform: 'uppercase' }}>Google Sheets Резервирование</legend>
                    <div className="form-grid" style={{ marginTop: '0.5rem' }}>
                      <div className="full-width">
                        <label>Google Sheets Webhook URL</label>
                        <input 
                          type="text" 
                          className="input-field" 
                          placeholder="https://script.google.com/macros/s/.../exec" 
                          value={settingsForm.google_sheets_webhook || ''}
                          onChange={(e) => setSettingsForm({ ...settingsForm, google_sheets_webhook: e.target.value })}
                        />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem', display: 'block', lineHeight: '1.4' }}>
                          Если настроено, то данные каждой созданной/измененной заявки будут отправляться методом POST в Google Sheets.
                        </span>
                      </div>
                    </div>
                  </fieldset>

                  {testLogs.length > 0 && (
                    <div style={{ 
                      backgroundColor: 'rgba(0,0,0,0.25)', 
                      border: '1px solid var(--border-color)', 
                      borderRadius: '6px', 
                      padding: '0.75rem 1rem',
                      fontFamily: 'monospace',
                      fontSize: '0.8125rem',
                      maxHeight: '120px',
                      overflowY: 'auto'
                    }}>
                      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>Логи проверки соединения:</div>
                      {testLogs.map((log, i) => (
                        <div key={i} style={{ margin: '0.15rem 0' }}>{log}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
                  <button 
                    type="button" 
                    className="btn btn-danger" 
                    disabled={testing} 
                    onClick={handleTestSettings}
                  >
                    {testing ? 'Проверка...' : '🔍 Проверить подключение'}
                  </button>
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowSettingsModal(false)}>Отмена</button>
                    <button type="submit" className="btn btn-primary">Сохранить</button>
                  </div>
                </div>
              </form>
            )}

            {/* TAB CONTENT: VALIDATORS */}
            {settingsTab === 'validators' && (
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Добавляйте и удаляйте коды авиакомпаний-валидаторов, используемых в форме создания билета.</p>
                
                {/* Form to add validator */}
                <form onSubmit={handleAddValidator} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
                  <div className="filter-group" style={{ flex: 1 }}>
                    <label>Код нового валидатора (например: TK)</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Введите код валидатора..." 
                      value={newValidatorCode}
                      onChange={(e) => setNewValidatorCode(e.target.value.toUpperCase())}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ height: '42px' }}>Добавить</button>
                </form>
                {validatorError && <span className="field-error">{validatorError}</span>}

                {/* List of validators */}
                <div style={{ 
                  marginTop: '1rem',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  maxHeight: '300px',
                  overflowY: 'auto'
                }}>
                  {validators.length === 0 ? (
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Список валидаторов пуст.</div>
                  ) : (
                    validators.map(code => (
                      <div 
                        key={code}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '0.75rem 1.25rem',
                          borderBottom: '1px solid var(--border-color)'
                        }}
                      >
                        <span style={{ fontWeight: '600', fontSize: '1rem' }}>✈️ {code}</span>
                        <button 
                          type="button" 
                          className="btn btn-danger" 
                          style={{ padding: '0.4rem 0.8rem', fontSize: '0.75rem' }}
                          onClick={() => handleDeleteValidator(code)}
                        >
                          Удалить
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HISTORY / AUDIT MODAL */}
      {showHistoryModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '550px' }}>
            <div className="modal-header">
              <h2>Журнал изменений и аудита</h2>
              <button className="btn-icon" onClick={() => setShowHistoryModal(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={{ marginBottom: '1.5rem', fontSize: '1rem' }}>
                Билет: <strong style={{ color: 'var(--accent-color)' }}>{activeRefund?.ticket_number}</strong><br/>
                Текущий статус: <span className={`badge ${getStatusBadgeClass(activeRefund?.status)}`}>{activeRefund?.status}</span>
              </div>
              
              <div className="timeline">
                {history.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Записей истории изменений нет.</div>
                ) : (
                  history.map((item, idx) => (
                    <div key={item.id} className={`timeline-item ${idx === 0 ? 'active-step' : ''}`}>
                      <div className="timeline-marker"></div>
                      <div className="timeline-content">
                        <div className="timeline-time">{new Date(item.created_at).toLocaleString('ru-RU')}</div>
                        <div className="timeline-title">
                          {item.old_status 
                            ? `Статус: ${item.old_status} ➡️ ${item.new_status}` 
                            : `Создана заявка (Статус: ${item.new_status})`}
                        </div>
                        <div className="timeline-author">Изменил: <strong>{item.changed_by}</strong></div>
                        {item.comment && (
                          <div className={`timeline-comment ${idx === 0 ? 'active-comment' : ''}`}>
                            {item.comment}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-primary" onClick={() => setShowHistoryModal(false)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
