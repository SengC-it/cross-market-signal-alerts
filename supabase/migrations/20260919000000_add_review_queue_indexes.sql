create index if not exists cr_sent_alerts_review_queue_idx
  on cr_sent_alerts (sent_at asc, signal_key)
  where delivery_status = 'sent'
    and (payload->'review' is null or payload->'review'->>'status' = 'pending');

create index if not exists cr_paper_model_runs_review_queue_idx
  on cr_paper_model_runs (rebalance_time asc, model_id)
  where review is null or review->>'status' = 'pending';
