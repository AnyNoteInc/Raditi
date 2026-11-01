import glob,os,re
checks=[('j5-job','02-list','Joomla 5 список','link "Welcome to your blog"'),('j5-job','edit.txt','Joomla 5 статья','button "Save & Close"'),('j5-job','edit.txt','Joomla 5 статья: текст','Rich Text Area'),
('j6-job','list.txt','Joomla 6 список','link "Welcome to your blog"'),('oc4-job','products','OC4 список','cell "iPhone"'),('oc4-job','form.txt','OC4 форма','button "Save"'),('oc4-job','form.txt','OC4 форма: имя','Product Name'),('oc4-job','form.txt','OC4 форма: текст','textbox "Editor, '),
('oc3-job','products','OC3 список','cell "iPhone"'),('oc3-job','form.txt','OC3 форма: имя','Product Name'),('mx3-job','resource','MODX 3 форма','button "Сохранить"'),('mx3-job','resource','MODX 3 текст','textbox "Содержимое"'),('mx2-job','resource','MODX 2 форма','button "Сохранить"')]
for d,pat,name,needle in checks:
    fs=sorted(f for f in glob.glob(f'../snap/{d}/*') if pat in os.path.basename(f))
    if not fs: print(name,'no file'); continue
    t=open(fs[-1],encoding='utf8').read(); body=t.split('\n',3)[3]
    print(f'{name:26} всего {len(body):6} знаков; "{needle}" на {body.find(needle):6}')
