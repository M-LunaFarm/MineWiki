import { exec } from './db.js';
import { pool } from './db.js';
import { schemaSql } from './schema.js';

for (const sql of schemaSql) {
  await exec(sql);
}

const compatibleAlterSql = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at DATETIME NULL AFTER email`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_sent_at DATETIME NULL AFTER email_verified_at`,
  `ALTER TABLE users MODIFY COLUMN status ENUM('pending','active','blocked','deleted') NOT NULL DEFAULT 'active'`,
  `CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    purpose ENUM('signup') NOT NULL DEFAULT 'signup',
    consumed_at DATETIME NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uk_email_verification_token_hash (token_hash),
    INDEX idx_email_verification_user (user_id),
    INDEX idx_email_verification_expires (expires_at),
    CONSTRAINT fk_email_verification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    consumed_at DATETIME NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uk_password_reset_token_hash (token_hash),
    INDEX idx_password_reset_user (user_id),
    INDEX idx_password_reset_expires (expires_at),
    CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE page_render_cache ADD COLUMN IF NOT EXISTS headings_json JSON NULL AFTER toc_json`,
  `ALTER TABLE page_render_cache ADD COLUMN IF NOT EXISTS warnings_json JSON NULL AFTER headings_json`,
  `ALTER TABLE page_render_cache ADD COLUMN IF NOT EXISTS footnotes_json JSON NULL AFTER warnings_json`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS parent_revision_id BIGINT UNSIGNED NULL AFTER revision_no`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS content_size INT UNSIGNED NOT NULL DEFAULT 0 AFTER content_hash`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS syntax_version VARCHAR(32) NOT NULL DEFAULT 'bwm-0.3' AFTER content_hash`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS is_minor TINYINT(1) NOT NULL DEFAULT 0 AFTER edit_summary`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS edit_tags JSON NULL AFTER is_minor`,
  `ALTER TABLE page_revisions MODIFY COLUMN visibility ENUM('public','hidden','admin_only','suppressed') NOT NULL DEFAULT 'public'`,
  `ALTER TABLE revision_visibility_logs MODIFY COLUMN old_visibility ENUM('public','hidden','admin_only','suppressed') NULL`,
  `ALTER TABLE revision_visibility_logs MODIFY COLUMN new_visibility ENUM('public','hidden','admin_only','suppressed') NOT NULL`,
  `UPDATE page_revisions SET content_size=OCTET_LENGTH(content_raw) WHERE content_size=0`,
  `UPDATE page_revisions r
   LEFT JOIN page_revisions prev ON prev.page_id=r.page_id AND prev.revision_no=r.revision_no-1
   SET r.parent_revision_id=prev.id
   WHERE r.parent_revision_id IS NULL AND r.revision_no > 1`,
  `ALTER TABLE page_revisions ADD INDEX IF NOT EXISTS idx_page_revisions_parent (parent_revision_id)`,
  `ALTER TABLE page_revisions ADD INDEX IF NOT EXISTS idx_page_revisions_visibility (visibility)`,
  `ALTER TABLE pages ADD COLUMN IF NOT EXISTS space_id BIGINT UNSIGNED NULL AFTER namespace_id`,
  `ALTER TABLE pages ADD COLUMN IF NOT EXISTS local_path VARCHAR(500) NULL AFTER space_id`,
  `ALTER TABLE pages ADD INDEX IF NOT EXISTS idx_pages_space (space_id)`,
  `ALTER TABLE pages ADD INDEX IF NOT EXISTS idx_pages_space_path (space_id, local_path)`,
  `ALTER TABLE pages MODIFY COLUMN protection_level ENUM('open','login_required','review_required','autoconfirmed_only','trusted_only','official_only','admin_only','owner_only','locked') NOT NULL DEFAULT 'open'`,
  `ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS space_key VARCHAR(64) NULL AFTER code`,
  `ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS title VARCHAR(255) NULL AFTER name`,
  `ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS slug VARCHAR(255) NULL AFTER title`,
  `ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS parent_space_id BIGINT UNSIGNED NULL AFTER space_type`,
  `ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS root_page_id BIGINT UNSIGNED NULL AFTER parent_space_id`,
  `ALTER TABLE wiki_spaces ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL AFTER status`,
  `ALTER TABLE wiki_spaces MODIFY COLUMN space_type ENUM('basic','mod_category','mod_wiki','server_category','server_wiki','developer','user_wiki','main','mod','mod_subwiki','modpack','server','server_subwiki','develop','help','project') NOT NULL DEFAULT 'basic'`,
  `UPDATE wiki_spaces
   SET space_type=CASE space_type
     WHEN 'main' THEN 'basic'
     WHEN 'help' THEN 'basic'
     WHEN 'project' THEN 'basic'
     WHEN 'mod' THEN 'mod_category'
     WHEN 'mod_subwiki' THEN 'mod_wiki'
     WHEN 'modpack' THEN 'mod_category'
     WHEN 'server' THEN 'server_category'
     WHEN 'server_subwiki' THEN 'server_wiki'
     WHEN 'develop' THEN 'developer'
     ELSE space_type
   END`,
  `ALTER TABLE wiki_spaces MODIFY COLUMN space_type ENUM('basic','mod_category','mod_wiki','server_category','server_wiki','developer','user_wiki') NOT NULL DEFAULT 'basic'`,
  `ALTER TABLE wiki_spaces MODIFY COLUMN status ENUM('pending','active','readonly','verification_expired','inactive','closed','needs_maintainer','outdated','merged','archived','hidden') NOT NULL DEFAULT 'active'`,
  `ALTER TABLE wiki_spaces ADD UNIQUE KEY IF NOT EXISTS uk_wiki_spaces_key (space_key)`,
  `ALTER TABLE wiki_spaces ADD UNIQUE KEY IF NOT EXISTS uk_wiki_spaces_slug (slug)`,
  `ALTER TABLE wiki_spaces ADD INDEX IF NOT EXISTS idx_wiki_spaces_parent (parent_space_id)`,
  `UPDATE wiki_spaces SET space_key=COALESCE(space_key, code), title=COALESCE(title, name), slug=COALESCE(slug, code)`,
  `UPDATE pages p
   JOIN namespaces n ON n.id=p.namespace_id
   JOIN wiki_spaces ws ON ws.root_namespace_code=n.code AND ws.space_type NOT IN ('server_wiki','mod_wiki','user_wiki')
   SET p.space_id=ws.id, p.local_path=p.title
   WHERE p.status!='deleted'`,
  `UPDATE pages p
   JOIN namespaces n ON n.id=p.namespace_id
   JOIN wiki_spaces ws ON ws.code=CONCAT(n.code, '-', SUBSTRING_INDEX(p.title, '/', 1)) AND ws.space_type IN ('server_wiki','mod_wiki')
   SET p.space_id=ws.id,
       p.local_path=CASE WHEN LOCATE('/', p.title) > 0 THEN SUBSTRING(p.title, LOCATE('/', p.title) + 1) ELSE '대문' END
   WHERE n.code IN ('server','mod') AND p.status!='deleted'`,
  `ALTER TABLE subwiki_settings ADD COLUMN IF NOT EXISTS sidebar_page_id BIGINT UNSIGNED NULL AFTER theme_key`,
  `ALTER TABLE subwiki_settings ADD COLUMN IF NOT EXISTS main_page_id BIGINT UNSIGNED NULL AFTER sidebar_page_id`,
  `ALTER TABLE subwiki_settings ADD COLUMN IF NOT EXISTS allow_public_edit TINYINT(1) NOT NULL DEFAULT 1 AFTER home_title`,
  `ALTER TABLE subwiki_settings ADD COLUMN IF NOT EXISTS require_review TINYINT(1) NOT NULL DEFAULT 0 AFTER public_edit_enabled`,
  `ALTER TABLE subwiki_settings MODIFY COLUMN short_path VARCHAR(255) NULL`,
  `ALTER TABLE subwiki_roles ADD COLUMN IF NOT EXISTS status ENUM('active','pending','revoked') NOT NULL DEFAULT 'active' AFTER role`,
  `ALTER TABLE subwiki_roles ADD COLUMN IF NOT EXISTS revoked_at DATETIME NULL AFTER granted_at`,
  `ALTER TABLE subwiki_roles ADD COLUMN IF NOT EXISTS revoked_by BIGINT UNSIGNED NULL AFTER revoked_at`,
  `ALTER TABLE subwiki_sidebar_items ADD COLUMN IF NOT EXISTS page_id BIGINT UNSIGNED NULL AFTER parent_id`,
  `ALTER TABLE subwiki_sidebar_items MODIFY COLUMN label VARCHAR(255) NOT NULL`,
  `CREATE TABLE IF NOT EXISTS document_templates (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    space_id BIGINT UNSIGNED NULL,
    template_key VARCHAR(128) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    template_scope ENUM('global','space','user') NOT NULL DEFAULT 'space',
    target_area ENUM('any','official','community','review_required') NOT NULL DEFAULT 'any',
    default_category VARCHAR(255) NULL,
    content_raw MEDIUMTEXT NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    status ENUM('active','draft','archived') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_template_space_key (space_id, template_key),
    INDEX idx_templates_space (space_id),
    INDEX idx_templates_scope (template_scope),
    INDEX idx_templates_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS template_fields (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    template_id BIGINT UNSIGNED NOT NULL,
    field_key VARCHAR(128) NOT NULL,
    label VARCHAR(255) NOT NULL,
    field_type ENUM('text','textarea','select','multiselect','date','url','checkbox') NOT NULL,
    required TINYINT(1) NOT NULL DEFAULT 0,
    options_json JSON NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_template_fields_template (template_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS starter_sets (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    set_key VARCHAR(128) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    target_space_type ENUM('mod_wiki','server_wiki','developer','basic') NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    status ENUM('active','draft','archived') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_starter_sets_key (set_key),
    INDEX idx_starter_sets_target (target_space_type),
    INDEX idx_starter_sets_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS starter_set_items (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    starter_set_id BIGINT UNSIGNED NOT NULL,
    local_path VARCHAR(500) NOT NULL,
    title VARCHAR(255) NOT NULL,
    template_id BIGINT UNSIGNED NULL,
    area ENUM('default','official','community','review_required') NOT NULL DEFAULT 'default',
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    INDEX idx_starter_items_set (starter_set_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE admin_work_items MODIFY COLUMN work_type ENUM('report','pending_review','server_claim','server_dispute','file_license','edit_filter_hit','restore_request','mod_link_review','subwiki_request','gitbook_import','develop_review','search_alias') NOT NULL`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS last_verified_at DATETIME NULL AFTER verified_at`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS renewal_required_at DATETIME NULL AFTER last_verified_at`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS target_host VARCHAR(255) NULL AFTER method`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS record_name VARCHAR(255) NULL AFTER target_host`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS expected_value VARCHAR(500) NULL AFTER record_name`,
  `ALTER TABLE server_claims MODIFY COLUMN token_plain VARCHAR(500) NULL`,
  `ALTER TABLE server_claims MODIFY COLUMN status ENUM('pending','verified','expired','failed','rejected','revoked') NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS last_checked_at DATETIME NULL AFTER expires_at`,
  `ALTER TABLE server_claims ADD COLUMN IF NOT EXISTS failure_reason TEXT NULL AFTER last_checked_at`,
  `CREATE TABLE IF NOT EXISTS server_dns_checks (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    claim_id BIGINT UNSIGNED NOT NULL,
    record_name VARCHAR(255) NOT NULL,
    expected_value VARCHAR(500) NOT NULL,
    found_values_json JSON NULL,
    status ENUM('pending','matched','not_found','mismatch','error') NOT NULL DEFAULT 'pending',
    error_message TEXT NULL,
    checked_at DATETIME NOT NULL,
    INDEX idx_dns_checks_claim (claim_id),
    INDEX idx_dns_checks_status (status),
    INDEX idx_dns_checks_checked_at (checked_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id CHAR(36) NULL AFTER id`,
  `ALTER TABLE users ADD UNIQUE KEY IF NOT EXISTS uk_users_account_id (account_id)`,
  `ALTER TABLE server_wikis ADD COLUMN IF NOT EXISTS port INT UNSIGNED NULL AFTER host`,
  `ALTER TABLE server_wikis ADD COLUMN IF NOT EXISTS vote_server_id CHAR(36) NULL AFTER space_id`,
  `ALTER TABLE server_wikis ADD UNIQUE KEY IF NOT EXISTS uk_server_wikis_vote_server (vote_server_id)`,
  `ALTER TABLE server_wikis MODIFY COLUMN verified_status ENUM('none','pending','verified','expiring','expired','revoked','disputed') NOT NULL DEFAULT 'none'`,
  `ALTER TABLE server_wikis ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL AFTER status`,
  `ALTER TABLE entity_servers MODIFY COLUMN verified_status ENUM('none','pending','verified','expiring','expired','revoked','disputed') NOT NULL DEFAULT 'none'`,
  `CREATE TABLE IF NOT EXISTS user_wikis (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    space_id BIGINT UNSIGNED NOT NULL,
    username_slug VARCHAR(255) NOT NULL,
    status ENUM('active','restricted','hidden') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_user_wikis_user (user_id),
    UNIQUE KEY uk_user_wikis_slug (username_slug),
    INDEX idx_user_wikis_space (space_id),
    INDEX idx_user_wikis_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS billing_plans (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    plan_key VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    price_monthly_krw INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('active','hidden','deprecated') NOT NULL DEFAULT 'active',
    features_json JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_billing_plans_key (plan_key),
    INDEX idx_billing_plans_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS server_subscriptions (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    server_wiki_id BIGINT UNSIGNED NOT NULL,
    plan_id BIGINT UNSIGNED NOT NULL,
    status ENUM('trialing','active','past_due','cancelled','expired') NOT NULL DEFAULT 'active',
    started_at DATETIME NOT NULL,
    renews_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_server_subscriptions_wiki (server_wiki_id),
    INDEX idx_server_subscriptions_status (status),
    INDEX idx_server_subscriptions_renews (renews_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS server_theme_settings (
    server_wiki_id BIGINT UNSIGNED PRIMARY KEY,
    theme_key VARCHAR(64) NULL,
    logo_file_id BIGINT UNSIGNED NULL,
    banner_file_id BIGINT UNSIGNED NULL,
    favicon_file_id BIGINT UNSIGNED NULL,
    primary_color VARCHAR(16) NULL,
    accent_color VARCHAR(16) NULL,
    background_mode ENUM('light','dark','system') NOT NULL DEFAULT 'system',
    custom_css TEXT NULL,
    custom_css_status ENUM('none','pending','approved','rejected') NOT NULL DEFAULT 'none',
    branding_mode ENUM('minewiki','compact','white_label') NOT NULL DEFAULT 'minewiki',
    updated_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE server_theme_settings ADD COLUMN IF NOT EXISTS branding_mode ENUM('minewiki','compact','white_label') NOT NULL DEFAULT 'minewiki' AFTER custom_css_status`,
  `CREATE TABLE IF NOT EXISTS server_custom_domains (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    server_wiki_id BIGINT UNSIGNED NOT NULL,
    domain VARCHAR(255) NOT NULL,
    status ENUM('pending','verified','active','failed','disabled') NOT NULL DEFAULT 'pending',
    verification_token_hash CHAR(64) NOT NULL,
    dns_record_name VARCHAR(255) NOT NULL,
    dns_record_value VARCHAR(500) NOT NULL,
    ssl_status ENUM('none','pending','active','failed') NOT NULL DEFAULT 'none',
    created_by BIGINT UNSIGNED NOT NULL,
    verified_at DATETIME NULL,
    activated_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_server_custom_domains_domain (domain),
    INDEX idx_custom_domains_server (server_wiki_id),
    INDEX idx_custom_domains_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_type ENUM('page','revision','user','file','server') NOT NULL DEFAULT 'page' AFTER id`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_id BIGINT UNSIGNED NULL AFTER target_type`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS detail TEXT NULL AFTER reason`,
  `ALTER TABLE reports MODIFY COLUMN status ENUM('open','reviewing','resolved','rejected') NOT NULL DEFAULT 'open'`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS handled_by BIGINT UNSIGNED NULL AFTER resolved_by`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS handled_at DATETIME NULL AFTER resolved_at`,
  `ALTER TABLE page_quality_issues MODIFY COLUMN issue_type ENUM('missing_status','missing_category','broken_link','needs_source','stub','outdated','disputed','missing_infobox','no_internal_links','mod_missing_check_date','server_missing_address') NOT NULL`,
  `ALTER TABLE page_quality_issues ADD INDEX IF NOT EXISTS idx_quality_issues_type (issue_type)`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS file_name VARCHAR(255) NULL AFTER original_name`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS source_text VARCHAR(500) NULL AFTER license`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS status ENUM('normal','license_needed','hidden','deleted') NOT NULL DEFAULT 'normal' AFTER source_text`,
  `ALTER TABLE files MODIFY COLUMN status ENUM('normal','license_needed','hidden','deleted') NOT NULL DEFAULT 'normal'`,
  `CREATE TABLE IF NOT EXISTS page_view_logs (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    page_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NULL,
    path VARCHAR(500) NOT NULL,
    viewed_at DATETIME NOT NULL,
    INDEX idx_page_views_page_time (page_id, viewed_at),
    INDEX idx_page_views_time (viewed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `UPDATE files SET file_name=original_name WHERE file_name IS NULL OR file_name=''`,
  `ALTER TABLE files MODIFY COLUMN file_name VARCHAR(255) NOT NULL`,
  `ALTER TABLE files ADD UNIQUE INDEX IF NOT EXISTS uk_files_file_name (file_name)`,
  `ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS payload_json JSON NULL AFTER reason`,
  `CREATE TABLE IF NOT EXISTS pending_review_drafts (
    review_id BIGINT UNSIGNED PRIMARY KEY,
    namespace_code VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content_raw MEDIUMTEXT NOT NULL,
    edit_summary VARCHAR(255) NULL,
    page_type VARCHAR(32) NULL,
    base_revision_id BIGINT UNSIGNED NULL,
    is_minor TINYINT(1) NOT NULL DEFAULT 0,
    edit_tags JSON NULL,
    created_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE pending_review_drafts ADD COLUMN IF NOT EXISTS is_minor TINYINT(1) NOT NULL DEFAULT 0 AFTER base_revision_id`,
  `ALTER TABLE pending_review_drafts ADD COLUMN IF NOT EXISTS edit_tags JSON NULL AFTER is_minor`,
  `CREATE TABLE IF NOT EXISTS page_protection_events (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    page_id BIGINT UNSIGNED NOT NULL,
    old_level ENUM('open','login_required','review_required','autoconfirmed_only','trusted_only','official_only','admin_only','owner_only','locked') NOT NULL,
    new_level ENUM('open','login_required','review_required','autoconfirmed_only','trusted_only','official_only','admin_only','owner_only','locked') NOT NULL,
    reason ENUM('manual','vandalism','edit_war','spam','privacy','server_dispute','policy','high_risk') NOT NULL,
    expires_at DATETIME NULL,
    changed_by BIGINT UNSIGNED NULL,
    is_automatic TINYINT(1) NOT NULL DEFAULT 0,
    note TEXT NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_page_protection_page (page_id),
    INDEX idx_page_protection_created (created_at),
    INDEX idx_page_protection_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS actor_type ENUM('user','ip') NOT NULL DEFAULT 'user' AFTER created_by`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS actor_user_id BIGINT UNSIGNED NULL AFTER actor_type`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS actor_ip VARBINARY(16) NULL AFTER actor_user_id`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS actor_ip_text VARCHAR(45) NULL AFTER actor_ip`,
  `ALTER TABLE page_revisions ADD COLUMN IF NOT EXISTS actor_ip_hash CHAR(64) NULL AFTER actor_ip_text`,
  `UPDATE page_revisions SET actor_user_id=created_by WHERE actor_user_id IS NULL AND created_by IS NOT NULL`,
  `ALTER TABLE page_revisions ADD INDEX IF NOT EXISTS idx_revisions_actor_user (actor_user_id)`,
  `ALTER TABLE page_revisions ADD INDEX IF NOT EXISTS idx_revisions_actor_ip_hash (actor_ip_hash)`,
  `CREATE TABLE IF NOT EXISTS acl_groups (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    group_key VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    status ENUM('active','hidden','archived') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_acl_groups_key (group_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS acl_group_members (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    group_id BIGINT UNSIGNED NOT NULL,
    member_type ENUM('user','ip','cidr') NOT NULL,
    user_id BIGINT UNSIGNED NULL,
    ip VARBINARY(16) NULL,
    cidr VARCHAR(64) NULL,
    reason TEXT NULL,
    expires_at DATETIME NULL,
    added_by BIGINT UNSIGNED NULL,
    added_at DATETIME NOT NULL,
    removed_at DATETIME NULL,
    INDEX idx_acl_group_members_group (group_id),
    INDEX idx_acl_group_members_user (user_id),
    INDEX idx_acl_group_members_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS acl_rules (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    target_type ENUM('site','space','page') NOT NULL,
    target_id BIGINT UNSIGNED NULL,
    action ENUM('read','edit','create','move','delete','revert','history','raw','create_thread','write_thread_comment','edit_request','upload_file','acl') NOT NULL,
    effect ENUM('allow','deny','goto_space') NOT NULL,
    subject_type ENUM('perm','user','ip','cidr','aclgroup','role') NOT NULL,
    subject_value VARCHAR(255) NOT NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    reason TEXT NULL,
    expires_at DATETIME NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_acl_target (target_type, target_id),
    INDEX idx_acl_action (action),
    INDEX idx_acl_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS acl_change_logs (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    target_type ENUM('site','space','page') NOT NULL,
    target_id BIGINT UNSIGNED NULL,
    action_type ENUM('insert','update','delete','reset') NOT NULL,
    old_rule_json JSON NULL,
    new_rule_json JSON NULL,
    reason TEXT NULL,
    changed_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_acl_logs_target (target_type, target_id),
    INDEX idx_acl_logs_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `INSERT IGNORE INTO acl_groups (group_key, title, description, created_at, updated_at) VALUES
    ('blocked', '차단 사용자', 'ACL 기본 차단 사용자 그룹', NOW(), NOW()),
    ('blocked_ip', '차단 IP', 'ACL 기본 차단 IP 그룹', NOW(), NOW()),
    ('vpn', 'VPN/프록시', 'VPN 또는 프록시 의심 대역', NOW(), NOW()),
    ('datacenter', '데이터센터', '데이터센터/호스팅 대역', NOW(), NOW()),
    ('spam', '스팸', '스팸 대응 그룹', NOW(), NOW()),
    ('warned', '주의 대상', '주의가 필요한 사용자 또는 IP', NOW(), NOW()),
    ('edit_request_blocked', '편집 요청 차단', '편집 요청 제한 대상', NOW(), NOW()),
    ('server_dispute', '서버 분쟁', '서버 분쟁 관련 제한 그룹', NOW(), NOW()),
    ('copyright_warning', '저작권 주의', '저작권 주의 대상', NOW(), NOW())`,
  `UPDATE pages p JOIN namespaces n ON n.id=p.namespace_id
   SET p.protection_level='review_required', p.status='protected', p.updated_at=NOW()
   WHERE n.code='main' AND p.title='대문' AND p.status!='deleted' AND p.protection_level='open'`,
  `ALTER TABLE page_requests ADD COLUMN IF NOT EXISTS namespace_id INT UNSIGNED NULL AFTER id`,
  `ALTER TABLE page_requests ADD COLUMN IF NOT EXISTS requested_title VARCHAR(255) NULL AFTER namespace_id`,
  `ALTER TABLE page_requests ADD COLUMN IF NOT EXISTS target_page_id BIGINT UNSIGNED NULL AFTER status`,
  `UPDATE page_requests pr LEFT JOIN namespaces n ON n.code=pr.namespace_code SET pr.namespace_id=COALESCE(pr.namespace_id, n.id), pr.requested_title=COALESCE(pr.requested_title, pr.title) WHERE pr.namespace_id IS NULL OR pr.requested_title IS NULL`,
  `UPDATE page_requests SET status='created' WHERE status='done'`,
  `UPDATE page_requests SET status='open' WHERE status='accepted'`,
  `ALTER TABLE page_requests MODIFY COLUMN namespace_id INT UNSIGNED NOT NULL`,
  `ALTER TABLE page_requests MODIFY COLUMN requested_title VARCHAR(255) NOT NULL`,
  `ALTER TABLE page_requests MODIFY COLUMN title VARCHAR(255) NULL`,
  `ALTER TABLE page_requests MODIFY COLUMN namespace_code VARCHAR(32) NULL`,
  `ALTER TABLE page_requests MODIFY COLUMN reason TEXT NULL`,
  `ALTER TABLE page_requests MODIFY COLUMN status ENUM('open','created','rejected','merged') NOT NULL DEFAULT 'open'`,
  `ALTER TABLE page_requests ADD INDEX IF NOT EXISTS idx_page_requests_namespace (namespace_id)`,
  `ALTER TABLE page_requests ADD INDEX IF NOT EXISTS idx_page_requests_title (requested_title)`,
  `ALTER TABLE discussion_threads MODIFY COLUMN status ENUM('open','resolved','locked','hidden') NOT NULL DEFAULT 'open'`,
  `ALTER TABLE discussion_threads ADD INDEX IF NOT EXISTS idx_discussion_threads_updated (updated_at)`,
  `ALTER TABLE discussion_comments ADD COLUMN IF NOT EXISTS parent_id BIGINT UNSIGNED NULL AFTER thread_id`,
  `ALTER TABLE discussion_comments ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL AFTER parent_id`,
  `UPDATE discussion_comments SET created_by=user_id WHERE created_by IS NULL AND user_id IS NOT NULL`,
  `ALTER TABLE discussion_comments MODIFY COLUMN visibility ENUM('public','hidden','admin_only') NOT NULL DEFAULT 'public'`,
  `ALTER TABLE discussion_comments ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL AFTER created_at`,
  `ALTER TABLE discussion_comments ADD INDEX IF NOT EXISTS idx_discussion_comments_parent (parent_id)`,
  `ALTER TABLE watched_pages ADD COLUMN IF NOT EXISTS watch_discussion TINYINT(1) NOT NULL DEFAULT 1 AFTER page_id`,
  `ALTER TABLE recent_changes MODIFY COLUMN change_type ENUM('create','edit','move','delete','restore','rollback','protect','unprotect','discussion','file_upload') NOT NULL`,
  `ALTER TABLE entity_servers ADD COLUMN IF NOT EXISTS operational_status ENUM('active','checking_failed','inactive','closed','disputed','unverified') NOT NULL DEFAULT 'unverified' AFTER verified_status`,
  `UPDATE entity_servers SET operational_status=CASE WHEN verified_status='verified' THEN 'active' WHEN verified_status='revoked' THEN 'inactive' ELSE 'unverified' END WHERE operational_status='unverified'`,
  `ALTER TABLE server_owners MODIFY COLUMN role ENUM('owner','manager','editor') NOT NULL DEFAULT 'editor'`,
  `ALTER TABLE server_owners MODIFY COLUMN status ENUM('active','pending','revoked') NOT NULL DEFAULT 'active'`,
  `ALTER TABLE server_owners ADD INDEX IF NOT EXISTS idx_server_owners_page (page_id)`,
  `UPDATE pages p JOIN namespaces n ON n.id=p.namespace_id SET p.protection_level='admin_only', p.status='protected', p.updated_at=NOW() WHERE n.code='project' AND p.page_type='policy' AND p.status!='deleted'`,
  `INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
   SELECT '서버 홍보성 표현 검토', '서버 문서의 광고성 표현은 검토 대기로 보낸다.', 'regex', '(최고의\\\\s*서버|1위\\\\s*서버|혜택\\\\s*지급|접속만\\\\s*해도|무료\\\\s*아이템|홍보\\\\s*이벤트)', 'require_review', NULL, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM edit_filters WHERE name='서버 홍보성 표현 검토')`,
  `INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
   SELECT '서버 사건 문단 검토', '서버 사건/논란 문단 편집은 검토 대기로 보낸다.', 'regex', '==\\\\s*(사건|논란|사건 및 논란|사건/논란)\\\\s*==', 'require_review', NULL, NOW(), NOW()
   WHERE NOT EXISTS (SELECT 1 FROM edit_filters WHERE name='서버 사건 문단 검토')`,
  `ALTER TABLE search_dictionary ADD COLUMN IF NOT EXISTS normalized_term VARCHAR(255) NULL AFTER normalized`,
  `ALTER TABLE search_dictionary ADD COLUMN IF NOT EXISTS replacement VARCHAR(255) NULL AFTER normalized_term`,
  `ALTER TABLE search_dictionary ADD COLUMN IF NOT EXISTS term_type ENUM('alias','typo','synonym','english','chosung','common_query') NOT NULL DEFAULT 'alias' AFTER target_page_id`,
  `ALTER TABLE search_dictionary ADD COLUMN IF NOT EXISTS enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER weight`,
  `UPDATE search_dictionary SET normalized_term=normalized WHERE normalized_term IS NULL OR normalized_term=''`,
  `UPDATE search_dictionary SET term_type=CASE WHEN action='boost' THEN 'common_query' WHEN action='disambiguation' THEN 'synonym' ELSE 'alias' END WHERE term_type IS NULL`,
  `ALTER TABLE search_dictionary MODIFY COLUMN normalized_term VARCHAR(255) NOT NULL`,
  `ALTER TABLE search_dictionary ADD INDEX IF NOT EXISTS idx_search_dictionary_normalized_term (normalized_term)`,
  `ALTER TABLE search_dictionary ADD INDEX IF NOT EXISTS idx_search_dictionary_target (target_page_id)`,
  `CREATE TABLE IF NOT EXISTS search_disambiguation_candidates (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    query VARCHAR(255) NOT NULL,
    normalized_query VARCHAR(255) NOT NULL,
    page_id BIGINT UNSIGNED NOT NULL,
    label VARCHAR(255) NULL,
    note VARCHAR(255) NULL,
    weight INT NOT NULL DEFAULT 100,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uk_search_disamb_query_page (query, page_id),
    INDEX idx_search_disamb_normalized (normalized_query),
    INDEX idx_search_disamb_page (page_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS data_tables (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    page_id BIGINT UNSIGNED NOT NULL,
    table_key VARCHAR(128) NOT NULL,
    caption VARCHAR(255) NOT NULL,
    headers_json JSON NOT NULL,
    source_component_index INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_data_tables_page_key (page_id, table_key),
    INDEX idx_data_tables_page (page_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS data_table_rows (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    table_id BIGINT UNSIGNED NOT NULL,
    row_no INT UNSIGNED NOT NULL,
    cells_json JSON NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uk_data_table_rows_table_row (table_id, row_no),
    INDEX idx_data_table_rows_table (table_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE OR REPLACE VIEW search_click_logs AS
   SELECT id, query_log_id, page_id, rank_no AS rank_position, user_id, created_at
   FROM search_result_clicks`,
  `UPDATE mod_verification_tasks SET task_type='version_check' WHERE task_type='content_review'`,
  `UPDATE mod_verification_tasks SET status='in_progress' WHERE status='assigned'`,
  `ALTER TABLE mod_verification_tasks MODIFY COLUMN task_type ENUM('version_check','link_check','dependency_check','loader_check') NOT NULL`,
  `ALTER TABLE mod_verification_tasks MODIFY COLUMN status ENUM('open','in_progress','done','skipped') NOT NULL DEFAULT 'open'`,
  `ALTER TABLE mod_verification_tasks ADD COLUMN IF NOT EXISTS note VARCHAR(255) NULL AFTER assigned_to`,
  `ALTER TABLE mod_verification_tasks ADD COLUMN IF NOT EXISTS completed_at DATETIME NULL AFTER due_at`,
  `ALTER TABLE mod_verification_tasks ADD INDEX IF NOT EXISTS idx_mod_tasks_type (task_type)`,
  `ALTER TABLE users ADD INDEX IF NOT EXISTS idx_users_created (created_at)`,
  `ALTER TABLE page_revisions ADD INDEX IF NOT EXISTS idx_page_revisions_created (created_at)`,
  `ALTER TABLE page_revisions ADD INDEX IF NOT EXISTS idx_page_revisions_actor_created (created_by, created_at)`,
  `ALTER TABLE page_revision_actions ADD INDEX IF NOT EXISTS idx_revision_actions_action_created (action, created_at)`,
  `ALTER TABLE recent_changes ADD INDEX IF NOT EXISTS idx_recent_changes_type_created (change_type, created_at)`,
  `ALTER TABLE recent_changes ADD INDEX IF NOT EXISTS idx_recent_changes_page_created (page_id, created_at)`,
  `ALTER TABLE discussion_comments ADD INDEX IF NOT EXISTS idx_discussion_comments_thread_visibility (thread_id, visibility)`,
  `ALTER TABLE search_query_logs ADD INDEX IF NOT EXISTS idx_search_query_logs_result_created (result_count, created_at)`,
  `ALTER TABLE mod_verification_tasks ADD INDEX IF NOT EXISTS idx_mod_tasks_status_updated (status, updated_at)`,
  `ALTER TABLE server_claims ADD INDEX IF NOT EXISTS idx_server_claims_status_created (status, created_at)`,
  `ALTER TABLE reports ADD INDEX IF NOT EXISTS idx_reports_status_created (status, created_at)`,
  `ALTER TABLE reports ADD INDEX IF NOT EXISTS idx_reports_page_status_created (page_id, status, created_at)`,
  `ALTER TABLE job_queue ADD INDEX IF NOT EXISTS idx_job_queue_status_run_id (status, run_after, id)`,
  `ALTER TABLE gitbook_import_jobs ADD COLUMN IF NOT EXISTS imported_pages INT UNSIGNED NOT NULL DEFAULT 0 AFTER status`,
  `ALTER TABLE mod_wikis ADD COLUMN IF NOT EXISTS category VARCHAR(128) NULL AFTER mod_name`,
  `ALTER TABLE mod_wikis ADD COLUMN IF NOT EXISTS creator_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER license`,
  `ALTER TABLE mod_wikis ADD COLUMN IF NOT EXISTS verified_by BIGINT UNSIGNED NULL AFTER creator_verified`,
  `ALTER TABLE mod_wikis ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL AFTER verified_by`
];

for (const sql of compatibleAlterSql) {
  await exec(sql);
}

await exec(`UPDATE pages p
  JOIN namespaces n ON n.id=p.namespace_id
  JOIN wiki_spaces ws ON ws.root_namespace_code=n.code AND ws.space_type NOT IN ('server_wiki','mod_wiki','user_wiki')
  SET p.space_id=ws.id, p.local_path=p.title
  WHERE p.space_id IS NULL OR p.local_path IS NULL OR p.local_path=''`);
await exec(`UPDATE pages p
  JOIN namespaces n ON n.id=p.namespace_id
  JOIN wiki_spaces ws ON ws.code=CONCAT(n.code, '-', SUBSTRING_INDEX(p.title, '/', 1)) AND ws.space_type IN ('server_wiki','mod_wiki')
  SET p.space_id=ws.id,
      p.local_path=CASE WHEN LOCATE('/', p.title) > 0 THEN SUBSTRING(p.title, LOCATE('/', p.title) + 1) ELSE '대문' END
  WHERE n.code IN ('server','mod')`);

const [legacyPagePathIndexes] = await pool.query(`SHOW INDEX FROM pages WHERE Key_name='idx_pages_space_path'`);
if ((legacyPagePathIndexes as any[]).length > 0) {
  await exec(`ALTER TABLE pages DROP INDEX idx_pages_space_path`);
}
await exec(`ALTER TABLE pages MODIFY COLUMN local_path VARCHAR(500) NOT NULL`);
await exec(`ALTER TABLE pages MODIFY COLUMN space_id BIGINT UNSIGNED NOT NULL`);
await exec(`ALTER TABLE pages ADD UNIQUE KEY IF NOT EXISTS uk_pages_space_path (space_id, local_path)`);

console.log(`Applied ${schemaSql.length} schema statements and ${compatibleAlterSql.length} compatibility alters.`);
await pool.end();
