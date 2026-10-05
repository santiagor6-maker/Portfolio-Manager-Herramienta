import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';
import { EmptyState } from '../components/ui';

export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="card">
      <EmptyState
        icon={<Compass size={20} />}
        title={t('notFound.title')}
        body={t('notFound.body')}
        action={
          <Link to="/" className="btn btn-primary">
            {t('nav.dashboard')}
          </Link>
        }
      />
    </div>
  );
}
