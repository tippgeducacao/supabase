import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface BackupData {
  timestamp: string;
  version: string;
  tables: {
    profiles: any[];
    form_entries: any[];
    alunos: any[];
    agendamentos: any[];
    leads: any[];
    cursos: any[];
    grupos_pos_graduacoes: any[];
    niveis_vendedores: any[];
    regras_comissionamento: any[];
    regras_pontuacao: any[];
    metas_semanais_vendedores: any[];
    metas_vendedores: any[];
    historico_mensal_planilhas: any[];
    respostas_formulario: any[];
    relatorios_diarios: any[];
    avaliacoes_semanais_vendedores: any[];
    eventos_especiais: any[];
    user_roles: any[];
  };
  stats: {
    total_records: number;
    tables_count: number;
    backup_size_mb: number;
  };
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('🔄 Iniciando backup do banco de dados...');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const backupData: BackupData = {
      timestamp: new Date().toISOString(),
      version: '1.0',
      tables: {
        profiles: [],
        form_entries: [],
        alunos: [],
        agendamentos: [],
        leads: [],
        cursos: [],
        grupos_pos_graduacoes: [],
        niveis_vendedores: [],
        regras_comissionamento: [],
        regras_pontuacao: [],
        metas_semanais_vendedores: [],
        metas_vendedores: [],
        historico_mensal_planilhas: [],
        respostas_formulario: [],
        relatorios_diarios: [],
        avaliacoes_semanais_vendedores: [],
        eventos_especiais: [],
        user_roles: []
      },
      stats: {
        total_records: 0,
        tables_count: 0,
        backup_size_mb: 0
      }
    };

    // Lista de tabelas para backup
    const tablesToBackup = [
      'profiles',
      'form_entries', 
      'alunos',
      'agendamentos',
      'leads',
      'cursos',
      'grupos_pos_graduacoes',
      'niveis_vendedores',
      'regras_comissionamento',
      'regras_pontuacao',
      'metas_semanais_vendedores',
      'metas_vendedores',
      'historico_mensal_planilhas',
      'respostas_formulario',
      'relatorios_diarios',
      'avaliacoes_semanais_vendedores',
      'eventos_especiais',
      'user_roles'
    ];

    console.log(`📋 Fazendo backup de ${tablesToBackup.length} tabelas...`);

    // Backup de cada tabela
    for (const tableName of tablesToBackup) {
      try {
        console.log(`🔍 Exportando tabela: ${tableName}`);
        
        const { data, error } = await supabase
          .from(tableName)
          .select('*')
          .order('created_at', { ascending: false, nullsFirst: false });

        if (error) {
          console.error(`❌ Erro ao exportar ${tableName}:`, error);
          continue;
        }

        backupData.tables[tableName as keyof typeof backupData.tables] = data || [];
        backupData.stats.total_records += (data || []).length;
        backupData.stats.tables_count++;
        
        console.log(`✅ ${tableName}: ${(data || []).length} registros exportados`);
      } catch (tableError) {
        console.error(`❌ Erro crítico na tabela ${tableName}:`, tableError);
      }
    }

    // Calcular tamanho aproximado do backup
    const backupJson = JSON.stringify(backupData);
    backupData.stats.backup_size_mb = Math.round((backupJson.length / 1024 / 1024) * 100) / 100;

    console.log('📊 Estatísticas do backup:', {
      total_records: backupData.stats.total_records,
      tables_count: backupData.stats.tables_count,
      backup_size_mb: backupData.stats.backup_size_mb
    });

    // Gerar nome do arquivo
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-database-${timestamp}.json`;

    // Salvar backup no storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('documentos-vendas')
      .upload(`backups/${fileName}`, backupJson, {
        contentType: 'application/json',
        cacheControl: '3600'
      });

    if (uploadError) {
      console.error('❌ Erro ao salvar backup:', uploadError);
      throw uploadError;
    }

    console.log('✅ Backup salvo com sucesso:', uploadData.path);

    // Limpar backups antigos (manter apenas os últimos 10)
    try {
      const { data: existingFiles } = await supabase.storage
        .from('documentos-vendas')
        .list('backups', {
          limit: 100,
          sortBy: { column: 'created_at', order: 'desc' }
        });

      if (existingFiles && existingFiles.length > 10) {
        const filesToDelete = existingFiles.slice(10).map(file => `backups/${file.name}`);
        
        const { error: deleteError } = await supabase.storage
          .from('documentos-vendas')
          .remove(filesToDelete);

        if (!deleteError) {
          console.log(`🗑️ ${filesToDelete.length} backups antigos removidos`);
        }
      }
    } catch (cleanupError) {
      console.error('⚠️ Erro ao limpar backups antigos:', cleanupError);
    }

    const response = {
      success: true,
      message: 'Backup realizado com sucesso',
      timestamp: backupData.timestamp,
      file_name: fileName,
      file_path: uploadData.path,
      stats: backupData.stats,
      summary: {
        total_tables: backupData.stats.tables_count,
        total_records: backupData.stats.total_records,
        file_size_mb: backupData.stats.backup_size_mb,
        storage_location: 'documentos-vendas/backups/'
      }
    };

    console.log('🎉 Backup concluído com sucesso!', response.summary);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('💥 Erro crítico no backup:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Erro interno no servidor durante o backup',
        details: (error as Error).message,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});