import { useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Progress,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CreateJob,
  type JobInput,
  type JobStatus,
  type ResultRow,
} from '../shared/contracts';
import { api } from './api';
import { ResultEditor } from './ResultEditor';
import { languageOptions } from '../shared/languages';
const { Title, Text, Paragraph } = Typography;
const labels: Record<JobStatus, string> = {
  queued: '排队中',
  running: '翻译中',
  succeeded: '翻译完成',
  partial: '部分成功',
  failed: '翻译失败',
};
const colors: Record<JobStatus, string> = {
  queued: 'default',
  running: 'processing',
  succeeded: 'success',
  partial: 'warning',
  failed: 'error',
};
const sample = JSON.stringify(
  {
    'common.save': 'Save',
    'welcome.message': 'Hello {name}, welcome to Nova!',
  },
  null,
  2,
);
export default function App() {
  const client = useQueryClient();
  const { message } = AntApp.useApp();
  const [source, setSource] = useState(sample);
  const [languages, setLanguages] = useState(['zh', 'fr']);
  const [glossary, setGlossary] = useState(
    '[{"source":"Nova","targets":{"zh":"Nova","fr":"Nova"}}]',
  );
  const [scenario, setScenario] = useState('normal');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<ResultRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 10000,
  });
  const isFake = health.data?.provider === 'fake';
  const isZhipu = health.data?.provider === 'zhipu';
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: api.jobs,
    refetchInterval: 2000,
  });
  const id = selected || jobs.data?.[0]?.id;
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.job(id!),
    enabled: !!id,
    refetchInterval: (q) =>
      ['queued', 'running'].includes(q.state.data?.status || 'queued')
        ? 1000
        : false,
  });
  const results = useQuery({
    queryKey: ['items', id],
    queryFn: () => api.items(id!),
    enabled: !!id,
    refetchInterval: (q) =>
      !q.state.data ||
      q.state.data.some(
        (item) => item.status === 'queued' || item.status === 'running',
      )
        ? 1000
        : false,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['jobs'] });
    void client.invalidateQueries({ queryKey: ['job', id] });
    void client.invalidateQueries({ queryKey: ['items', id] });
  };
  const create = useMutation({
    mutationFn: api.create,
    onSuccess: (data) => {
      setSelected(data.id);
      setFormError(null);
      void client.invalidateQueries({ queryKey: ['jobs'] });
      message.success('任务已创建');
    },
    onError: (error) => setFormError(error.message),
  });
  const edit = useMutation({
    mutationFn: (row: ResultRow) =>
      api.edit(row.job_id, row.id, {
        text: row.target_text!,
        approved: true,
        revision: row.revision,
      }),
    onSuccess: refresh,
    onError: (error) => message.error(error.message),
  });
  const retry = useMutation({
    mutationFn: () => api.retry(id!),
    onSuccess: refresh,
    onError: (error) => message.error(error.message),
  });
  const exportFile = useMutation({
    mutationFn: (lang: string) => api.export(id!, lang),
    onError: (error) => message.error(error.message),
  });
  function submit() {
    try {
      const values: unknown = JSON.parse(source);
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new Error('英文输入必须是 JSON 对象');
      const input = {
        entries: Object.entries(values).map(([key, text]) => ({ key, text })),
        languages,
        glossary: JSON.parse(glossary),
        scenario: isFake ? scenario : 'normal',
      };
      if (!Value.Check(CreateJob, input))
        throw new Error(
          '请检查：1–50 个非空英文 key/value、至少一个语言，以及术语 JSON 格式',
        );
      create.mutate(input as JobInput);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '输入格式错误');
    }
  }
  const rows = results.data || [];
  const columns = [
    {
      title: 'Key / 英文',
      dataIndex: 'source_key',
      width: 240,
      render: (_: string, row: ResultRow) => (
        <div>
          <Text strong>{row.source_key}</Text>
          <div className="source-copy">{row.source_text}</div>
        </div>
      ),
    },
    {
      title: '语言',
      dataIndex: 'language',
      width: 76,
      render: (lang: string) => <Tag>{lang}</Tag>,
    },
    {
      title: '翻译结果',
      dataIndex: 'target_text',
      render: (_: string, row: ResultRow) => (
        <div>
          <div className="result-copy">{row.target_text || '等待翻译结果'}</div>
          {row.error_code ? <Text type="danger">{row.error_code}</Text> : null}
          {row.human_edited ? <Tag color="purple">人工修改</Tag> : null}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 115,
      render: (_: string, row: ResultRow) => (
        <Space direction="vertical" size={2}>
          <Tag color={colors[row.status]}>{labels[row.status]}</Tag>
          <Text type="secondary">尝试 {row.attempts}/3</Text>
        </Space>
      ),
    },
    {
      title: '审核',
      dataIndex: 'approved',
      width: 96,
      render: (approved: boolean) => (
        <Tag color={approved ? 'success' : 'default'}>
          {approved ? '已审核' : '未审核'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, row: ResultRow) => (
        <Space>
          <Button size="small" onClick={() => setEditing(row)}>
            编辑
          </Button>
          {row.status === 'succeeded' && !row.approved ? (
            <Button
              size="small"
              loading={edit.isPending}
              onClick={() => edit.mutate(row)}
            >
              审核
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];
  return (
    <main className="lab-shell">
      <header className="lab-header">
        <div>
          <div className="eyebrow">LEARNING PROJECT · V1</div>
          <Title level={1}>AI Translation Lab</Title>
          <Paragraph>
            把一份英文文案，变成可检查、可追踪、可导出的多语言结果。
          </Paragraph>
        </div>
        <Tag color="cyan">
          {isZhipu
            ? `智谱 · ${health.data?.model}`
            : isFake
              ? 'Fake Translator'
              : '连接服务中'}
        </Tag>
      </header>
      <Alert
        type="info"
        showIcon
        message={
          isZhipu
            ? '已连接智谱真实翻译。结果仍需人工检查并审核后导出。'
            : isFake
              ? '当前是模拟翻译：用于学习完整流程，不代表真实语言质量，也不会调用任何模型或使用密钥。'
              : '正在确认翻译服务状态。'
        }
        className="mode-note"
      />
      <div className="lab-grid">
        <aside>
          <Card title="创建翻译任务" className="create-card">
            <label htmlFor="source-json">英文 key / value</label>
            <Input.TextArea
              id="source-json"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              rows={7}
              spellCheck={false}
            />
            <div className="field">
              <label htmlFor="languages">目标语言</label>
              <Select
                id="languages"
                mode="multiple"
                value={languages}
                onChange={setLanguages}
                options={languageOptions}
                maxTagCount="responsive"
                style={{ width: '100%' }}
              />
              <Space size="small" className="language-actions">
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    setLanguages(
                      languageOptions.map((language) => language.value),
                    )
                  }
                >
                  全选 50 种
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() => setLanguages([])}
                >
                  清空
                </Button>
              </Space>
            </div>
            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'advanced',
                  label: isFake ? '术语与可靠性实验' : '术语设置',
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <label htmlFor="glossary">术语表 JSON</label>
                      <Input.TextArea
                        id="glossary"
                        rows={3}
                        value={glossary}
                        onChange={(e) => setGlossary(e.target.value)}
                      />
                      {isFake ? (
                        <>
                          <label htmlFor="scenario">故障实验</label>
                          <Select
                            id="scenario"
                            value={scenario}
                            onChange={setScenario}
                            style={{ width: '100%' }}
                            options={[
                              { label: '正常完成', value: 'normal' },
                              {
                                label: '首次网络失败 → 自动重试',
                                value: 'transient',
                              },
                              {
                                label: '首次结构错误 → 自动重试',
                                value: 'malformed',
                              },
                              {
                                label: '法语持续失败 → 部分成功',
                                value: 'partial',
                              },
                            ]}
                          />
                        </>
                      ) : null}
                    </Space>
                  ),
                },
              ]}
            />
            {formError ? (
              <Alert
                type="error"
                showIcon
                message={formError}
                className="field"
              />
            ) : null}
            <Button
              type="primary"
              size="large"
              block
              onClick={submit}
              loading={create.isPending}
              disabled={!health.data}
            >
              创建任务
            </Button>
          </Card>
          <Card
            title="最近任务"
            className="history-card"
            extra={<Text type="secondary">保存在数据库</Text>}
          >
            {jobs.error ? (
              <Alert
                type="error"
                message="无法连接服务"
                description={jobs.error.message}
              />
            ) : jobs.isLoading ? (
              <Spin />
            ) : jobs.data?.length ? (
              jobs.data.map((item) => (
                <button
                  className={`job-button ${id === item.id ? 'selected' : ''}`}
                  key={item.id}
                  onClick={() => {
                    setSelected(item.id);
                    setEditing(null);
                  }}
                >
                  <div>
                    <Text strong>
                      {new Date(item.created_at).toLocaleString('zh-CN')}
                    </Text>
                    <Tag color={colors[item.status]}>{labels[item.status]}</Tag>
                  </div>
                  <span>
                    {item.languages.join(' · ')} · {item.completed}/{item.total}{' '}
                    个结果 · 已审核 {item.approved}
                  </span>
                </button>
              ))
            ) : (
              <Empty
                description="还没有任务"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            )}
          </Card>
        </aside>
        <section aria-label="翻译任务详情">
          {id ? (
            <Card
              title="任务与结果"
              extra={<Button onClick={refresh}>刷新</Button>}
            >
              {job.error || results.error ? (
                <Alert
                  type="error"
                  message={job.error?.message || results.error?.message}
                />
              ) : null}
              {job.data ? (
                <>
                  <div className="job-summary">
                    <Tag color={colors[job.data.status]}>
                      {labels[job.data.status]}
                    </Tag>
                    <Text>
                      已处理 {job.data.completed}/{job.data.total}
                    </Text>
                    <Text type="secondary">
                      已审核 {job.data.approved} · 失败 {job.data.failed}
                    </Text>
                  </div>
                  <Progress
                    percent={Math.round(
                      (job.data.completed / job.data.total) * 100,
                    )}
                    status={
                      job.data.status === 'failed' ? 'exception' : 'normal'
                    }
                  />
                  <Text type="secondary" className="job-id">
                    任务 {job.data.id}
                  </Text>
                </>
              ) : null}
              {job.data?.status === 'partial' ? (
                <Alert
                  type="warning"
                  showIcon
                  message="部分语言失败，已成功的结果已保存。可以人工修正失败结果，或重试失败项。"
                  className="field"
                />
              ) : null}
              <div className="result-toolbar">
                <Text strong>逐语言结果</Text>
                <Space wrap>
                  {job.data?.failed ? (
                    <Button
                      onClick={() => retry.mutate()}
                      loading={retry.isPending}
                    >
                      重试失败项
                    </Button>
                  ) : null}
                  {job.data?.languages.map((lang) => {
                    const langRows = rows.filter((r) => r.language === lang);
                    const ready =
                      langRows.length > 0 &&
                      langRows.every(
                        (r) => r.status === 'succeeded' && r.approved,
                      );
                    return (
                      <Button
                        key={lang}
                        disabled={!ready}
                        loading={exportFile.isPending}
                        onClick={() => exportFile.mutate(lang)}
                      >
                        导出 {lang}.json
                      </Button>
                    );
                  })}
                </Space>
              </div>
              <Table<ResultRow>
                rowKey="id"
                columns={columns}
                dataSource={rows}
                loading={results.isLoading}
                pagination={false}
                scroll={{ x: 900 }}
              />
              <Paragraph type="secondary" className="export-note">
                检查翻译内容、占位符和术语后审核；同一语言的全部结果审核完成后，才能导出
                JSON。失败项重试会保留已成功和人工修改的结果。
              </Paragraph>
            </Card>
          ) : (
            <Card className="empty-detail">
              <div className="empty-number">01 → 02 → 03</div>
              <Title level={3}>创建 · 检查 · 导出</Title>
              <Paragraph type="secondary">
                从左侧的英文样例开始。任务与结果会持续保存，刷新页面后仍可继续审核。
              </Paragraph>
            </Card>
          )}
        </section>
      </div>
      {editing ? (
        <ResultEditor
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
            message.success('结果已保存');
          }}
        />
      ) : null}
      <footer>
        独立的学习实验 ·{' '}
        <a
          href="http://127.0.0.1:4310/api/docs"
          target="_blank"
          rel="noreferrer"
        >
          API 文档
        </a>
      </footer>
    </main>
  );
}
